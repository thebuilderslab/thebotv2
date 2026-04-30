/**
 * Schwab Order Placement Service
 *
 * Submits options orders via Schwab Trader API after operator approval.
 * Orders are staged in D1 (pending_orders table) before execution.
 *
 * Flow:
 *   1. Agent generates recommendation → stores as pending_order in D1
 *   2. Telegram message includes "Approve to execute" button (callback: execute_order:{id})
 *   3. Operator taps approve → this service submits to Schwab
 *   4. Confirmation sent back to Telegram
 *
 * Schwab Trader API:
 *   POST /trader/v1/accounts/{encryptedAccountNumber}/orders
 */

import { run, queryOne, query } from "../db/schema";
import { getAccessToken } from "./schwab-auth";

const TRADER_BASE = "https://api.schwabapi.com/trader/v1";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OptionLeg {
  instruction:  "BUY_TO_OPEN" | "BUY_TO_CLOSE" | "SELL_TO_OPEN" | "SELL_TO_CLOSE";
  quantity:     number;
  symbol:       string;    // OCC symbol e.g. "GOOGL  260421C00340000"
  asset_type:   "OPTION";
}

export interface PendingOrder {
  id:             string;
  account_number: string;  // last 4 digits
  order_type:     "NET_CREDIT" | "NET_DEBIT" | "LIMIT";
  price:          number;  // net limit price (positive = credit)
  legs:           OptionLeg[];
  description:    string;  // human label e.g. "Roll 340C→355C for $0.87 credit"
  created_at:     string;
  expires_at:     string;  // orders expire if not approved within 30 min
  status:         "pending_approval" | "submitted" | "rejected" | "expired";
}

interface SchwabAccountHashRow {
  account_number: string;
  hash_value:     string;
}

// ── Stage a pending order ─────────────────────────────────────────────────────

export async function stagePendingOrder(
  db: D1Database,
  order: Omit<PendingOrder, "id" | "created_at" | "expires_at" | "status">,
): Promise<string> {
  const id        = crypto.randomUUID();
  const now       = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 90 * 60 * 1000).toISOString(); // 90 min — covers 3pm alert through 4:30pm close

  await run(db, `
    INSERT INTO pending_orders
      (id, account_number, order_type, price, legs, description, created_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending_approval')
  `, [id, order.account_number, order.order_type, order.price,
      JSON.stringify(order.legs), order.description, now, expiresAt]);

  return id;
}

// ── Load a pending order ──────────────────────────────────────────────────────

export async function loadPendingOrder(db: D1Database, id: string): Promise<PendingOrder | null> {
  const row = await queryOne<{
    id: string; account_number: string; order_type: string;
    price: number; legs: string; description: string;
    created_at: string; expires_at: string; status: string;
  }>(db, `SELECT * FROM pending_orders WHERE id = ?`, [id]);

  if (!row) return null;

  return {
    id:             row.id,
    account_number: row.account_number,
    order_type:     row.order_type as PendingOrder["order_type"],
    price:          row.price,
    legs:           JSON.parse(row.legs) as OptionLeg[],
    description:    row.description,
    created_at:     row.created_at,
    expires_at:     row.expires_at,
    status:         row.status as PendingOrder["status"],
  };
}

// ── Get encrypted account hash ────────────────────────────────────────────────
// Schwab requires the hashValue (not the raw account number) for order placement.
// We fetch and cache it in D1 agent_notes.

export async function getAccountHash(
  db: D1Database,
  clientId: string,
  clientSecret: string,
  last4: string,
): Promise<string> {
  // Check cache
  const cached = await queryOne<{ value: string }>(
    db,
    `SELECT value FROM agent_notes WHERE agent_id = 'agent-finance-lead' AND key = ?`,
    [`schwab_hash_${last4}`],
  );
  if (cached?.value) return cached.value;

  // Fetch from Schwab
  const token = await getAccessToken(db, clientId, clientSecret);
  const resp  = await fetch(`${TRADER_BASE}/accounts`, {
    headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) throw new Error(`Schwab accounts ${resp.status}: ${await resp.text()}`);

  const accounts = await resp.json() as Array<{
    securitiesAccount: { accountNumber: string; hashValue?: string };
  }>;

  // Cache all hashes we got back
  const now = new Date().toISOString();
  for (const acct of accounts) {
    const acctLast4 = acct.securitiesAccount.accountNumber.slice(-4);
    const hash      = acct.securitiesAccount.hashValue ?? "";
    if (hash) {
      await run(db, `
        INSERT INTO agent_notes (agent_id, key, value, created_at, updated_at)
        VALUES ('agent-finance-lead', ?, ?, ?, ?)
        ON CONFLICT (agent_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
      `, [`schwab_hash_${acctLast4}`, hash, now, now]);
    }
  }

  // Return the requested one
  const target = accounts.find(
    (a) => a.securitiesAccount.accountNumber.slice(-4) === last4
  );
  if (!target?.securitiesAccount.hashValue) {
    throw new Error(`Account ...${last4} not found or has no hashValue`);
  }
  return target.securitiesAccount.hashValue;
}

// ── Submit order to Schwab ────────────────────────────────────────────────────

export async function executeOrder(
  db: D1Database,
  clientId: string,
  clientSecret: string,
  orderId: string,
): Promise<{ ok: boolean; order_id?: string; error?: string }> {
  const pending = await loadPendingOrder(db, orderId);
  if (!pending) return { ok: false, error: "Order not found" };
  if (pending.status !== "pending_approval") {
    return { ok: false, error: `Order already ${pending.status}` };
  }
  if (new Date(pending.expires_at) < new Date()) {
    await run(db, `UPDATE pending_orders SET status='expired', updated_at=? WHERE id=?`,
      [new Date().toISOString(), orderId]);
    return { ok: false, error: "Order expired (>90 min). Generate a fresh recommendation." };
  }

  const hashValue = await getAccountHash(db, clientId, clientSecret, pending.account_number);
  const token     = await getAccessToken(db, clientId, clientSecret);

  // Build Schwab order body
  const orderLegs = pending.legs.map((leg) => ({
    instruction:  leg.instruction,
    quantity:     leg.quantity,
    instrument: {
      symbol:    leg.symbol,
      assetType: "OPTION",
    },
  }));

  const orderBody = {
    orderType:          pending.order_type === "NET_CREDIT" ? "NET_CREDIT"
                      : pending.order_type === "NET_DEBIT"  ? "NET_DEBIT"
                      : "LIMIT",
    session:            "NORMAL",
    price:              pending.price.toFixed(2),
    duration:           "DAY",
    orderStrategyType:  "SINGLE",
    orderLegCollection: orderLegs,
  };

  const resp = await fetch(`${TRADER_BASE}/accounts/${hashValue}/orders`, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json",
      "Accept":        "application/json",
    },
    body:    JSON.stringify(orderBody),
    signal:  AbortSignal.timeout(15_000),
  });

  const now = new Date().toISOString();

  if (!resp.ok) {
    const body = await resp.text();
    await run(db, `UPDATE pending_orders SET status='rejected', updated_at=? WHERE id=?`, [now, orderId]);
    return { ok: false, error: `Schwab rejected order ${resp.status}: ${body.slice(0, 300)}` };
  }

  // Schwab returns 201 with Location header containing the order ID
  const location = resp.headers.get("Location") ?? "";
  const schwabOrderId = location.split("/").pop() ?? "unknown";

  await run(db, `UPDATE pending_orders SET status='submitted', updated_at=? WHERE id=?`, [now, orderId]);

  return { ok: true, order_id: schwabOrderId };
}

// ── Format a pending order for Telegram ──────────────────────────────────────

export function formatOrderForTelegram(order: PendingOrder): string {
  const legs = order.legs.map((leg) => {
    const side = leg.instruction.includes("BUY") ? "BUY" : "SELL";
    return `${side} ${leg.quantity}× ${leg.symbol}`;
  }).join("\n  ");

  const creditDebit = order.order_type === "NET_CREDIT"
    ? `Net credit: $${order.price.toFixed(2)}`
    : `Net debit: $${order.price.toFixed(2)}`;

  return `📋 ${order.description}\n\n  ${legs}\n\n${creditDebit}\nExpires: ${new Date(order.expires_at).toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET`;
}
