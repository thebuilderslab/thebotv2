/**
 * Schwab OAuth Routes
 *
 * GET  /api/schwab/auth      — redirect to Schwab authorization page (one-time setup)
 * GET  /api/schwab/callback  — OAuth callback: exchange code → tokens → store in D1
 * GET  /api/schwab/status    — check authorization status + token expiry
 * POST /api/schwab/refresh   — manually force token refresh
 */

import { Hono } from "hono";
import type { Env } from "../index";
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  storeTokens,
  loadTokens,
  isAuthorized,
  getAccessToken,
} from "../services/schwab-auth";

export const schwabRouter = new Hono<{ Bindings: Env }>();

// ── Step 1: Redirect to Schwab login ─────────────────────────────────────────

schwabRouter.get("/api/schwab/auth", (c) => {
  const clientId = c.env.SCHWAB_CLIENT_ID;
  if (!clientId) return c.json({ error: "SCHWAB_CLIENT_ID not set" }, 500);
  const url = buildAuthUrl(clientId);
  return c.redirect(url, 302);
});

// ── Step 2: Receive authorization code, exchange for tokens ──────────────────

schwabRouter.get("/api/schwab/callback", async (c) => {
  const code  = c.req.query("code");
  const error = c.req.query("error");

  if (error) {
    return c.html(`
      <html><body style="font-family:monospace;padding:40px;background:#0d0f14;color:#ff4a4a">
        <h2>❌ Schwab Authorization Failed</h2>
        <p>Error: ${error}</p>
        <p>Description: ${c.req.query("error_description") ?? "unknown"}</p>
        <p><a href="/api/schwab/auth" style="color:#4a9eff">Try again</a></p>
      </body></html>
    `, 400);
  }

  if (!code) {
    // Dump all query params so we can see what Schwab actually sent
    const allParams: Record<string, string> = {};
    const url = new URL(c.req.url);
    url.searchParams.forEach((v, k) => { allParams[k] = v; });
    return c.html(`
      <html><body style="font-family:monospace;padding:40px;background:#0d0f14;color:#ff4a4a">
        <h2>❌ No authorization code received</h2>
        <p>Expected ?code= parameter from Schwab redirect.</p>
        <p style="color:#ffd700">Full URL received:</p>
        <pre style="color:#4aff8a;white-space:pre-wrap;word-break:break-all">${c.req.url}</pre>
        <p style="color:#ffd700">All query parameters:</p>
        <pre style="color:#4aff8a">${JSON.stringify(allParams, null, 2)}</pre>
        <p><a href="/api/schwab/auth" style="color:#4a9eff">Try again</a></p>
      </body></html>
    `, 400);
  }

  const clientId     = c.env.SCHWAB_CLIENT_ID;
  const clientSecret = c.env.SCHWAB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return c.json({ error: "SCHWAB_CLIENT_ID or SCHWAB_CLIENT_SECRET not configured" }, 500);
  }

  try {
    const tokens = await exchangeCodeForTokens(code, clientId, clientSecret);
    await storeTokens(c.env.DB, tokens);

    // Notify via Telegram
    if (c.env.TELEGRAM_BOT_TOKEN && c.env.TELEGRAM_CHAT_ID) {
      await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id:    c.env.TELEGRAM_CHAT_ID,
          text:       `✅ *Schwab API authorized successfully*\n\nBot Nation is now connected to your Schwab account.\nAccess token expires: ${new Date(tokens.expires_at).toLocaleString("en-US", { timeZone: "America/New_York" })} ET\n\nThe bridge will auto-refresh tokens. No further action needed.`,
          parse_mode: "Markdown",
        }),
      }).catch(() => {});
    }

    return c.html(`
      <html><body style="font-family:monospace;padding:40px;background:#0d0f14;color:#4aff8a">
        <h2>✅ Schwab Authorization Complete</h2>
        <p>Bot Nation is now connected to your Schwab account.</p>
        <p style="color:#8892b0">Access token expires: ${new Date(tokens.expires_at).toLocaleString()}</p>
        <p style="color:#8892b0">Refresh token stored securely in D1. Auto-refreshes every 30 minutes.</p>
        <br>
        <p style="color:#ffd700">You can close this tab. A Telegram notification has been sent.</p>
        <br>
        <p><a href="https://bot-nation-console.pages.dev/map" style="color:#4a9eff">→ Open Bot Nation console</a></p>
      </body></html>
    `);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.html(`
      <html><body style="font-family:monospace;padding:40px;background:#0d0f14;color:#ff4a4a">
        <h2>❌ Token Exchange Failed</h2>
        <pre style="color:#ff8a4a;white-space:pre-wrap">${msg}</pre>
        <p><a href="/api/schwab/auth" style="color:#4a9eff">Try again</a></p>
      </body></html>
    `, 500);
  }
});

// ── Status check ─────────────────────────────────────────────────────────────

schwabRouter.get("/api/schwab/status", async (c) => {
  const authorized = await isAuthorized(c.env.DB);
  if (!authorized) {
    return c.json({
      authorized:   false,
      message:      "Not authorized. Visit /api/schwab/auth to connect your Schwab account.",
      auth_url:     "https://bot-nation-api.thejamalshackleford.workers.dev/api/schwab/auth",
    });
  }

  const tokens = await loadTokens(c.env.DB);
  const expiresAt  = tokens?.expires_at ? new Date(tokens.expires_at) : null;
  const minutesLeft = expiresAt ? Math.round((expiresAt.getTime() - Date.now()) / 60_000) : 0;

  return c.json({
    authorized:    true,
    expires_at:    tokens?.expires_at,
    minutes_until_refresh: minutesLeft,
    status:        minutesLeft > 0 ? "active" : "needs_refresh",
  });
});

// ── Manual token refresh ──────────────────────────────────────────────────────

schwabRouter.post("/api/schwab/refresh", async (c) => {
  const clientId     = c.env.SCHWAB_CLIENT_ID;
  const clientSecret = c.env.SCHWAB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return c.json({ error: "Schwab credentials not configured" }, 500);
  }
  try {
    const token = await getAccessToken(c.env.DB, clientId, clientSecret);
    return c.json({ ok: true, message: "Token refreshed", token_preview: token.slice(0, 8) + "..." });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
