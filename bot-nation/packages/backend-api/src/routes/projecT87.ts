/**
 * projecT87 Routes — bot-nation-api proxy over the native DeFi service.
 *
 *   GET  /api/p87/status          — is the integration configured?
 *   GET  /api/p87/health          — projecT87 liveness (read-only)
 *   GET  /api/p87/vault/health    — Aave health factor + collateral/debt (read-only)
 *   GET  /api/p87/notifications   — recent notifications (read-only)
 *   POST /api/p87/credit/borrow   — EXPERIMENTAL, APPROVAL-GATED. Records intent
 *                                   ONLY; never executes on-chain. Not autonomous.
 *
 * The read-only routes proxy to projecT87 via the typed client. If PROJECT87_API_URL/
 * PROJECT87_API_KEY are unset the integration is NOT WIRED and returns 503.
 */

import { Hono } from "hono";
import type { Env } from "../index";
import { run } from "../db/schema";
import {
  isP87Configured,
  p87Health,
  p87VaultHealth,
  p87Notifications,
  P87NotConfiguredError,
} from "../services/projecT87-client";

export const projecT87Router = new Hono<{ Bindings: Env }>();

const NOT_WIRED = {
  error: "projecT87 NOT WIRED",
  detail: "Set PROJECT87_API_URL and PROJECT87_API_KEY to enable the DeFi integration.",
};

// ── GET /api/p87/status ───────────────────────────────────────────────────────
projecT87Router.get("/api/p87/status", (c) => {
  return c.json({
    configured: isP87Configured(c.env),
    wired_endpoints: ["/api/p87/health", "/api/p87/vault/health", "/api/p87/notifications"],
    gated_endpoints: ["/api/p87/credit/borrow (EXPERIMENTAL — approval only, non-autonomous)"],
  });
});

// ── GET /api/p87/health (read-only) ───────────────────────────────────────────
projecT87Router.get("/api/p87/health", async (c) => {
  try {
    return c.json(await p87Health(c.env));
  } catch (err) {
    if (err instanceof P87NotConfiguredError) return c.json(NOT_WIRED, 503);
    return c.json({ error: (err as Error).message }, 502);
  }
});

// ── GET /api/p87/vault/health (read-only) ─────────────────────────────────────
projecT87Router.get("/api/p87/vault/health", async (c) => {
  try {
    return c.json(await p87VaultHealth(c.env));
  } catch (err) {
    if (err instanceof P87NotConfiguredError) return c.json(NOT_WIRED, 503);
    return c.json({ error: (err as Error).message }, 502);
  }
});

// ── GET /api/p87/notifications (read-only) ────────────────────────────────────
projecT87Router.get("/api/p87/notifications", async (c) => {
  try {
    return c.json({ notifications: await p87Notifications(c.env) });
  } catch (err) {
    if (err instanceof P87NotConfiguredError) return c.json(NOT_WIRED, 503);
    return c.json({ error: (err as Error).message }, 502);
  }
});

// ── POST /api/p87/credit/borrow — EXPERIMENTAL, APPROVAL-GATED ─────────────────
// This route deliberately does NOT execute the on-chain borrow. It validates the
// request, records the intent as an event, and returns a pending-approval marker.
// Actual execution after human approval is intentionally NOT WIRED.
projecT87Router.post("/api/p87/credit/borrow", async (c) => {
  let body: { amount?: number; asset?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const amount = Number(body.amount);
  const asset = String(body.asset ?? "").toUpperCase();
  const ALLOWED = ["DAI", "USDC", "USDT"];
  if (!(amount > 0) || amount > 10000) {
    return c.json({ error: "amount must be > 0 and <= 10000" }, 422);
  }
  if (!ALLOWED.includes(asset)) {
    return c.json({ error: `asset must be one of ${ALLOWED.join(", ")}` }, 422);
  }

  // Record intent for the audit trail — NO on-chain execution here.
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await run(
    c.env.DB,
    `INSERT INTO events (id, kind, actor_id, target_kind, target_id, payload, session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      "p87.borrow_requested",
      "operator",
      "tool",
      "p87_credit_borrow",
      JSON.stringify({ amount, asset, status: "pending_approval", executed: false }),
      null,
      now,
      now,
    ],
  );

  return c.json(
    {
      status: "pending_approval",
      executed: false,
      note: "EXPERIMENTAL — on-chain borrow requires explicit human approval and is NOT wired to autonomous execution. Intent recorded only.",
      request: { amount, asset },
      event_id: id,
    },
    202,
  );
});
