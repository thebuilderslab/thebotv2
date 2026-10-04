/**
 * Schwab OAuth2 Token Manager
 *
 * Flow:
 *   1. User visits the auth URL (one-time, manual step)
 *   2. Schwab redirects to /api/schwab/callback with ?code=
 *   3. Callback exchanges code → access_token + refresh_token
 *   4. Tokens stored in D1 agent_notes under agent-finance-lead
 *   5. getAccessToken() auto-refreshes when expired — no manual intervention needed
 *
 * Token lifetimes:
 *   access_token  : 30 minutes
 *   refresh_token : 7 days (resets on every use)
 */

import { run, queryOne } from "../db/schema";
import { claimCronTick, releaseCronTick } from "./cron-cas";

const REFRESH_LOCK_KEY = "schwab_token_refresh";

const SCHWAB_TOKEN_URL   = "https://api.schwabapi.com/v1/oauth/token";
const SCHWAB_AUTH_URL    = "https://api.schwabapi.com/v1/oauth/authorize";
const CALLBACK_URL       = "https://bot-nation-api.thejamalshackleford.workers.dev/api/schwab/callback";
const TOKEN_AGENT_ID     = "agent-finance-lead";

export interface SchwabTokens {
  access_token:  string;
  refresh_token: string;
  expires_at:    string; // ISO timestamp
}

// ── Build the one-time authorization URL ─────────────────────────────────────

export function buildAuthUrl(clientId: string): string {
  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  CALLBACK_URL,
    response_type: "code",
    scope:         "readonly",
  });
  return `${SCHWAB_AUTH_URL}?${params.toString()}`;
}

// ── Exchange authorization code for tokens ────────────────────────────────────

export async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<SchwabTokens> {
  const credentials = btoa(`${clientId}:${clientSecret}`);

  const resp = await fetch(SCHWAB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type":  "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type:   "authorization_code",
      code,
      redirect_uri: CALLBACK_URL,
    }).toString(),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Schwab token exchange failed ${resp.status}: ${body}`);
  }

  const data = await resp.json() as {
    access_token:  string;
    refresh_token: string;
    expires_in:    number;
    token_type:    string;
  };

  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    new Date(Date.now() + data.expires_in * 1000).toISOString(),
  };
}

// ── Refresh access token using stored refresh token ───────────────────────────

export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<SchwabTokens> {
  const credentials = btoa(`${clientId}:${clientSecret}`);

  const resp = await fetch(SCHWAB_TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type":  "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: refreshToken,
    }).toString(),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Schwab token refresh failed ${resp.status}: ${body}`);
  }

  const data = await resp.json() as {
    access_token:  string;
    refresh_token: string;
    expires_in:    number;
  };

  return {
    access_token:  data.access_token,
    refresh_token: data.refresh_token,
    expires_at:    new Date(Date.now() + data.expires_in * 1000).toISOString(),
  };
}

// ── Persist tokens to D1 (agent_notes on agent-finance-lead) ─────────────────

export async function storeTokens(db: D1Database, tokens: SchwabTokens): Promise<void> {
  const now = new Date().toISOString();
  const upsert = async (key: string, value: string) => {
    await run(
      db,
      `INSERT INTO agent_notes (agent_id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (agent_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      [TOKEN_AGENT_ID, key, value, now, now],
    );
  };
  await Promise.all([
    upsert("schwab_access_token",  tokens.access_token),
    upsert("schwab_refresh_token", tokens.refresh_token),
    upsert("schwab_expires_at",    tokens.expires_at),
  ]);
}

// ── Load tokens from D1 ───────────────────────────────────────────────────────

export async function loadTokens(db: D1Database): Promise<SchwabTokens | null> {
  const rows = await Promise.all([
    queryOne<{ value: string }>(db, "SELECT value FROM agent_notes WHERE agent_id=? AND key=?", [TOKEN_AGENT_ID, "schwab_access_token"]),
    queryOne<{ value: string }>(db, "SELECT value FROM agent_notes WHERE agent_id=? AND key=?", [TOKEN_AGENT_ID, "schwab_refresh_token"]),
    queryOne<{ value: string }>(db, "SELECT value FROM agent_notes WHERE agent_id=? AND key=?", [TOKEN_AGENT_ID, "schwab_expires_at"]),
  ]);

  if (!rows[0] || !rows[1] || !rows[2]) return null;

  return {
    access_token:  rows[0].value,
    refresh_token: rows[1].value,
    expires_at:    rows[2].value,
  };
}

// ── Get a valid access token (auto-refreshes if expired) ─────────────────────

function isFresh(tokens: SchwabTokens): boolean {
  // 5 min > 2 min: ensures token is fresh even when a cron fires at the same
  // clock-minute as the last refresh (e.g. midday task at :30, exit check at :00).
  return Date.now() < new Date(tokens.expires_at).getTime() - 300_000;
}

export async function getAccessToken(
  db: D1Database,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const stored = await loadTokens(db);
  if (!stored) throw new Error("Schwab not authorized. Visit /api/schwab/auth to start OAuth flow.");

  if (isFresh(stored)) {
    return stored.access_token;
  }

  // ── Refresh, guarded by a CAS lock ──────────────────────────────────────────
  // Schwab rotates refresh_token on every use, so two concurrent callers
  // (e.g. the heartbeat tick and an in-flight finance-lead task) racing to
  // refresh with the same refresh_token can leave the loser with a dead token.
  // Only the lock winner calls Schwab; everyone else waits for the fresh
  // tokens to land in D1 and reads those instead.
  const claim = await claimCronTick(db, REFRESH_LOCK_KEY, { ttlMs: 15_000 });

  if (!claim.ok) {
    for (let attempt = 0; attempt < 10; attempt++) {
      await scheduler.wait(300);
      const latest = await loadTokens(db);
      if (latest && isFresh(latest)) return latest.access_token;
    }
    // Refresh in flight elsewhere didn't land in time — fall through and
    // attempt it ourselves rather than blocking the caller indefinitely.
  }

  try {
    // Re-read: the lock winner (or whoever we waited on) may have already
    // refreshed while we were claiming/waiting.
    const latest = await loadTokens(db);
    if (latest && isFresh(latest)) return latest.access_token;

    const fresh = await refreshAccessToken(latest?.refresh_token ?? stored.refresh_token, clientId, clientSecret);
    await storeTokens(db, fresh);
    return fresh.access_token;
  } finally {
    if (claim.ok) await releaseCronTick(db, REFRESH_LOCK_KEY);
  }
}

// ── Check if authorized ───────────────────────────────────────────────────────

export async function isAuthorized(db: D1Database): Promise<boolean> {
  const tokens = await loadTokens(db);
  return !!tokens?.refresh_token;
}
