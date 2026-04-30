/**
 * Finance Routes
 *
 * GET  /api/finance/targets          — latest target per watchlist symbol
 * GET  /api/finance/targets/:symbol  — latest + history for one symbol
 * POST /api/finance/targets/refresh  — trigger fresh analysis now
 * POST /api/finance/watchlist        — add symbol to price target watchlist
 *
 * GET  /api/finance/positions        — stored positions + account summaries
 * POST /api/finance/positions/sync   — pull latest from Schwab API + store
 * GET  /api/finance/quotes           — real-time quotes for held symbols (or ?symbols=X,Y)
 */

import { Hono } from "hono";
import type { Env } from "../index";
import { run } from "../db/schema";
import {
  generatePriceTargets,
  getStoredTargets,
} from "../services/price-target-service";
import {
  syncPositions,
  getStoredPositions,
  fetchQuotes,
  fetchOptionsChain,
  calcPortfolioTotals,
} from "../services/schwab-positions";
import {
  executeOrder,
  loadPendingOrder,
  stagePendingOrder,
  formatOrderForTelegram,
} from "../services/schwab-orders";

export const financeRouter = new Hono<{ Bindings: Env }>();

// ── GET /api/finance/targets ──────────────────────────────────────────────────
// Returns the most recent price target per symbol across the whole watchlist.

financeRouter.get("/api/finance/targets", async (c) => {
  const targets = await getStoredTargets(c.env.DB);
  return c.json({ targets, count: targets.length });
});

// ── GET /api/finance/targets/:symbol ─────────────────────────────────────────
// Returns the latest + up to 4 prior targets for a single symbol.

financeRouter.get("/api/finance/targets/:symbol", async (c) => {
  const symbol = c.req.param("symbol").toUpperCase();
  const targets = await getStoredTargets(c.env.DB, symbol);

  if (targets.length === 0) {
    return c.json({ error: `No targets found for ${symbol}` }, 404);
  }

  return c.json({
    symbol,
    latest: targets[0],
    history: targets.slice(1),
    count: targets.length,
  });
});

// ── POST /api/finance/targets/refresh ────────────────────────────────────────
// Trigger a fresh analysis for all watchlist symbols (or a provided subset).
// Body (optional): { symbols: string[] }

financeRouter.post("/api/finance/targets/refresh", async (c) => {
  let symbols: string[] | undefined;

  try {
    const body = await c.req.json<{ symbols?: string[] }>();
    if (Array.isArray(body.symbols) && body.symbols.length > 0) {
      symbols = body.symbols.map((s) => s.toUpperCase());
    }
  } catch {
    // No body or invalid JSON — fall through and use watchlist
  }

  const targets = await generatePriceTargets(
    c.env.DB,
    {
      TRADING_URL: c.env.TRADING_URL,
      ANTHROPIC_API_KEY: c.env.ANTHROPIC_API_KEY,
      OPENROUTER_API_KEY: c.env.OPENROUTER_API_KEY,
    },
    symbols,
  );

  return c.json({
    status: "ok",
    generated: targets.length,
    targets,
  });
});

// ── POST /api/finance/watchlist ───────────────────────────────────────────────
// Add a symbol to the tws_watchlist (shared with thinkorswim integration).
// Body: { symbol: string, asset_type?: string, notes?: string }

financeRouter.post("/api/finance/watchlist", async (c) => {
  let body: { symbol?: string; asset_type?: string; notes?: string };

  try {
    body = await c.req.json<{ symbol?: string; asset_type?: string; notes?: string }>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.symbol) {
    return c.json({ error: "symbol is required" }, 400);
  }

  const symbol = body.symbol.toUpperCase();
  const id     = crypto.randomUUID();
  const now    = new Date().toISOString();

  await run(
    c.env.DB,
    `INSERT OR IGNORE INTO tws_watchlist (id, symbol, asset_type, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, symbol, body.asset_type ?? "equity", body.notes ?? null, now, now],
  );

  return c.json({ status: "ok", id, symbol });
});

// ── GET /api/finance/positions ────────────────────────────────────────────────
// Returns positions + account summaries stored in D1 from last sync.

financeRouter.get("/api/finance/positions", async (c) => {
  const { positions, accounts, synced_at } = await getStoredPositions(c.env.DB);
  const totals = calcPortfolioTotals(accounts, positions);

  return c.json({
    accounts,
    positions,
    totals,
    synced_at,
    count: positions.length,
  });
});

// ── POST /api/finance/positions ───────────────────────────────────────────────
// Agent-callable alias (http_api tool) — same data as the GET but POST-friendly.
// Registered as D1 tool "schwab_positions" (kind=http_api) so agents can call it.
// Body: {} (empty — no params required)

financeRouter.post("/api/finance/positions", async (c) => {
  const { positions, accounts, synced_at } = await getStoredPositions(c.env.DB);
  const totals = calcPortfolioTotals(accounts, positions);

  // Summarise positions in a concise format so the LLM context stays small
  const summary = positions.map((p) => ({
    symbol:         p.symbol,
    asset_type:     p.asset_type,
    description:    p.description,
    quantity:       p.quantity,
    average_price:  p.average_price,
    market_value:   p.market_value,
    unrealized_pnl: p.unrealized_pnl,
    account:        p.account_label ?? p.account_number,
  }));

  return c.json({
    positions: summary,
    synced_at,
    count:  positions.length,
    totals: {
      total_value:          totals.total_value,
      total_invested:       totals.total_invested,
      total_unrealized_pnl: totals.total_unrealized_pnl,
      total_day_pnl:        totals.total_day_pnl,
    },
  });
});

// ── POST /api/finance/positions/sync ──────────────────────────────────────────
// Pull latest positions from Schwab API and store in D1.

financeRouter.post("/api/finance/positions/sync", async (c) => {
  const clientId     = c.env.SCHWAB_CLIENT_ID;
  const clientSecret = c.env.SCHWAB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return c.json({ error: "Schwab credentials not configured" }, 500);
  }

  try {
    const { positions, accounts } = await syncPositions(c.env.DB, clientId, clientSecret);
    const totals = calcPortfolioTotals(accounts, positions);
    return c.json({
      status:   "ok",
      synced:   new Date().toISOString(),
      accounts: accounts.length,
      positions: positions.length,
      totals,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── GET /api/finance/quotes ───────────────────────────────────────────────────
// Real-time quotes. Uses symbols from held positions by default.
// Optional: ?symbols=AAPL,MSFT,NVDA to specify subset / extras.

financeRouter.get("/api/finance/quotes", async (c) => {
  const clientId     = c.env.SCHWAB_CLIENT_ID;
  const clientSecret = c.env.SCHWAB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return c.json({ error: "Schwab credentials not configured" }, 500);
  }

  // Resolve symbol list: query param overrides, otherwise all held symbols
  let symbols: string[];
  const qParam = c.req.query("symbols");

  if (qParam) {
    symbols = qParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  } else {
    const { positions } = await getStoredPositions(c.env.DB);
    symbols = [...new Set(positions.map((p) => p.symbol))];
  }

  if (symbols.length === 0) {
    return c.json({ quotes: [], message: "No symbols — sync positions first or pass ?symbols=" });
  }

  try {
    const quotes = await fetchQuotes(c.env.DB, clientId, clientSecret, symbols);
    return c.json({ quotes, count: quotes.length, as_of: new Date().toISOString() });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── POST /api/finance/options ──────────────────────────────────────────────────
// Fetch live options chain from Schwab for a given symbol.
// Body: { symbol: string, contract_type?: "CALL"|"PUT"|"ALL", strike_count?: number,
//         from_date?: "YYYY-MM-DD", to_date?: "YYYY-MM-DD" }
// Registered as D1 tool "schwab_options_chain" (kind=http_api) so agents can call it.

financeRouter.post("/api/finance/options", async (c) => {
  const clientId     = c.env.SCHWAB_CLIENT_ID;
  const clientSecret = c.env.SCHWAB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return c.json({ error: "Schwab credentials not configured" }, 500);
  }

  let body: {
    symbol?: string;
    contract_type?: "CALL" | "PUT" | "ALL";
    strike_count?: number;
    from_date?: string;
    to_date?: string;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.symbol) return c.json({ error: "symbol is required" }, 400);

  try {
    const chain = await fetchOptionsChain(c.env.DB, clientId, clientSecret, body.symbol, {
      contractType: body.contract_type,
      strikeCount:  body.strike_count,
      fromDate:     body.from_date,
      toDate:       body.to_date,
    });

    return c.json(chain);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ── POST /api/finance/orders/stage ────────────────────────────────────────────
// Stage a pending order for operator approval.
// Body: { account_number, order_type, price, legs, description }
// Returns: { id } — the pending order ID to embed in Telegram "Approve" button.

financeRouter.post("/api/finance/orders/stage", async (c) => {
  const clientId = c.env.SCHWAB_CLIENT_ID;
  if (!clientId) return c.json({ error: "Schwab not configured" }, 500);

  let body: {
    account_number?: string;
    order_type?: string;
    price?: number;
    legs?: unknown;
    description?: string;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.account_number || !body.order_type || body.price == null || !body.legs || !body.description) {
    return c.json({ error: "account_number, order_type, price, legs, and description are required" }, 400);
  }

  const id = await stagePendingOrder(c.env.DB, {
    account_number: body.account_number,
    order_type:     body.order_type as "NET_CREDIT" | "NET_DEBIT" | "LIMIT",
    price:          body.price,
    legs:           body.legs as Parameters<typeof stagePendingOrder>[1]["legs"],
    description:    body.description,
  });

  const order = await loadPendingOrder(c.env.DB, id);
  return c.json({
    status: "staged",
    id,
    expires_at: order?.expires_at,
    telegram_preview: order ? formatOrderForTelegram(order) : null,
  });
});

// ── POST /api/finance/orders/execute ──────────────────────────────────────────
// Execute a previously staged pending order after operator approval.
// Body: { order_id: string }
// Called by the Telegram "Approve to execute" button handler.

financeRouter.post("/api/finance/orders/execute", async (c) => {
  const clientId     = c.env.SCHWAB_CLIENT_ID;
  const clientSecret = c.env.SCHWAB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return c.json({ error: "Schwab credentials not configured" }, 500);
  }

  let body: { order_id?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.order_id) return c.json({ error: "order_id is required" }, 400);

  const result = await executeOrder(c.env.DB, clientId, clientSecret, body.order_id);

  if (!result.ok) {
    return c.json({ status: "error", error: result.error }, 400);
  }

  return c.json({
    status:          "submitted",
    schwab_order_id: result.order_id,
    message:         `Order submitted to Schwab (ID: ${result.order_id})`,
  });
});

// ── GET /api/finance/orders/pending ──────────────────────────────────────────
// List all orders awaiting approval (for the dashboard).

financeRouter.get("/api/finance/orders/pending", async (c) => {
  const { query } = await import("../db/schema");
  const orders = await query<{
    id: string; account_number: string; order_type: string; price: number;
    description: string; created_at: string; expires_at: string; status: string;
  }>(c.env.DB, `
    SELECT id, account_number, order_type, price, description, created_at, expires_at, status
    FROM pending_orders
    WHERE status = 'pending_approval' AND expires_at > datetime('now')
    ORDER BY created_at DESC
    LIMIT 20
  `, []);

  return c.json({ orders, count: orders.length });
});
