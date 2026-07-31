/**
 * projecT87 client — typed HTTP client for the vendored native DeFi service
 * (bot-nation/projecT87/, FastAPI + Web3 on Arbitrum).
 *
 * The service is deployed separately (like the other Render services) and reached
 * over HTTP via PROJECT87_API_URL. All endpoints are gated by an X-API-Key header,
 * supplied from PROJECT87_API_KEY (which the service maps to a wallet).
 *
 * Schemas mirror api_server.py Pydantic models exactly.
 *
 * SAFETY: the read-only calls (health, vaultHealth, notifications) are safe to call.
 * `borrow` performs an on-chain WRITE and is EXPERIMENTAL — it is intentionally NOT
 * called by any route/cron. It exists only so a future, explicitly human-approved,
 * attended path can use it. Never wire it into autonomous execution.
 */

export interface P87Env {
  PROJECT87_API_URL?: string;
  PROJECT87_API_KEY?: string;
}

/** GET /api/v1/vault/health → HealthResponse */
export interface P87VaultHealth {
  wallet_address: string;
  health_factor: number;
  total_collateral_usd: number;
  total_debt_usd: number;
  net_worth_usd: number;
  available_borrows_usd: number;
}

/** GET /api/v1/notifications → NotificationItem[] */
export interface P87Notification {
  id: number;
  title: string;
  message: string;
  priority: string;
  created_at: string;
}

/** POST /api/v1/credit/borrow request/response */
export interface P87BorrowRequest {
  amount: number; // > 0, <= 10000
  asset: string; // DAI | USDC | USDT
}
export interface P87BorrowResponse {
  wallet_address: string;
  status: string;
  mode: string;
  action: string;
  details: string;
}

export class P87NotConfiguredError extends Error {
  constructor() {
    super("projecT87 is NOT WIRED: PROJECT87_API_URL / PROJECT87_API_KEY are not set");
    this.name = "P87NotConfiguredError";
  }
}

function base(env: P87Env): string {
  if (!env.PROJECT87_API_URL) throw new P87NotConfiguredError();
  return env.PROJECT87_API_URL.replace(/\/$/, "");
}

async function p87Fetch<T>(env: P87Env, path: string, init?: RequestInit): Promise<T> {
  const url = `${base(env)}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": env.PROJECT87_API_KEY ?? "",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => res.statusText);
    throw new Error(`projecT87 ${path} → ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

/** Whether the integration is configured at all. */
export function isP87Configured(env: P87Env): boolean {
  return !!(env.PROJECT87_API_URL && env.PROJECT87_API_KEY);
}

// ── READ-ONLY (safe, wired) ───────────────────────────────────────────────────

/** GET /api/v1/health — liveness. */
export function p87Health(env: P87Env): Promise<{ status?: string; [k: string]: unknown }> {
  return p87Fetch(env, "/api/v1/health");
}

/** GET /api/v1/vault/health — Aave health factor + collateral/debt for the wallet. */
export function p87VaultHealth(env: P87Env): Promise<P87VaultHealth> {
  return p87Fetch<P87VaultHealth>(env, "/api/v1/vault/health");
}

/** GET /api/v1/notifications — recent notifications for the wallet. */
export function p87Notifications(env: P87Env): Promise<P87Notification[]> {
  return p87Fetch<P87Notification[]>(env, "/api/v1/notifications");
}

// ── ON-CHAIN WRITE (EXPERIMENTAL — NOT WIRED) ─────────────────────────────────

/**
 * POST /api/v1/credit/borrow — EXPERIMENTAL on-chain borrow.
 * Deliberately NOT called by any route or cron. Do not invoke from an autonomous
 * or unattended path. Reserved for a future explicitly-approved, attended flow.
 */
export function p87Borrow(env: P87Env, req: P87BorrowRequest): Promise<P87BorrowResponse> {
  return p87Fetch<P87BorrowResponse>(env, "/api/v1/credit/borrow", {
    method: "POST",
    body: JSON.stringify(req),
  });
}
