/**
 * thinkorswim Routes
 *
 * POST /api/tws/ws/register      — Register WebSocket session
 * POST /api/tws/ws/ping          — Keep-alive ping
 * POST /api/tws/ws/tick          — Push tick data from TOS
 * POST /api/tws/alert            — Price alert triggered by TOS
 * POST /api/tws/stream           — Batch tick refresh (called by streaming cron)
 * POST /api/tws/backtest         — Submit TOS backtest export for skill creation
 * POST /api/tws/order-entry      — Get pre-populated order params from agents
 * GET  /api/tws/positions        — Current open positions with marks
 * GET  /api/tws/signals          — Recent trading signals
 * GET  /api/tws/watchlist        — Active watchlist
 * PATCH /api/tws/positions/:id   — Update position (mark, P/L, DTE)
 */

import { Hono } from "hono";
import type { Env } from "../index";
import { query, queryOne, run } from "../db/schema";
import {
  registerWsSession,
  pingWsSession,
  closeWsSession,
  processTick,
  handleAlertTrigger,
  refreshStreamingData,
  validateBacktest,
  generateOrderEntry,
  getActiveWatchlist,
  type TickData,
  type AlertTrigger,
  type BacktestExport,
  type OrderEntryRequest,
} from "../services/thinkorswim-bridge";

export const twsRouter = new Hono<{ Bindings: Env }>();

// ── WebSocket Bridge ──────────────────────────────────────────────────────────

/** Register a new TOS desktop session */
twsRouter.post("/api/tws/ws/register", async (c) => {
  const body = await c.req.json<{ client_label?: string; symbols?: string[] }>();
  const sessionId = await registerWsSession(
    c.env.DB,
    body.client_label ?? "thinkorswim",
    body.symbols ?? [],
  );
  return c.json({ session_id: sessionId, status: "registered" });
});

/** Keep-alive ping from TOS */
twsRouter.post("/api/tws/ws/ping", async (c) => {
  const body = await c.req.json<{ session_id: string }>();
  if (!body.session_id) return c.json({ error: "session_id required" }, 400);
  await pingWsSession(c.env.DB, body.session_id);
  return c.json({ status: "ok", ts: new Date().toISOString() });
});

/** Disconnect session */
twsRouter.post("/api/tws/ws/disconnect", async (c) => {
  const body = await c.req.json<{ session_id: string }>();
  if (!body.session_id) return c.json({ error: "session_id required" }, 400);
  await closeWsSession(c.env.DB, body.session_id);
  return c.json({ status: "disconnected" });
});

/**
 * Push a single tick from TOS ThinkScript / AutoHotkey.
 * TOS calls this endpoint every time a price updates on the watched symbol.
 *
 * ThinkScript usage:
 *   AddLabel(yes, "SEND", Color.GREEN);
 *   # On alert: call /api/tws/ws/tick with symbol, price, rsi, macd
 */
twsRouter.post("/api/tws/ws/tick", async (c) => {
  const tick = await c.req.json<TickData>();
  if (!tick.symbol || !tick.price) {
    return c.json({ error: "symbol and price required" }, 400);
  }
  tick.timestamp = tick.timestamp ?? new Date().toISOString();
  await processTick(c.env.DB, tick);
  return c.json({ status: "ok", symbol: tick.symbol, price: tick.price });
});

// ── Watchlist Alerts ──────────────────────────────────────────────────────────

/**
 * Called by TOS when a price alert fires.
 * Triggers multi-agent analysis + Telegram notification.
 *
 * TOS Alert Setup:
 *   1. Set up price alert in thinkorswim (right-click chart → Set Alert)
 *   2. In "Alert Action", choose "Execute Script" or use AutoHotkey to POST here
 *   3. Body: { symbol, trigger_type, trigger_val, direction, current_price, current_rsi }
 */
twsRouter.post("/api/tws/alert", async (c) => {
  const trigger = await c.req.json<AlertTrigger>();

  if (!trigger.symbol || !trigger.current_price) {
    return c.json({ error: "symbol and current_price required" }, 400);
  }

  trigger.timestamp = trigger.timestamp ?? new Date().toISOString();
  trigger.trigger_type = trigger.trigger_type ?? "PRICE_CROSS";

  const signalId = await handleAlertTrigger(c.env.DB, {
    TELEGRAM_BOT_TOKEN: c.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: c.env.TELEGRAM_CHAT_ID,
    TRADING_URL: c.env.TRADING_URL,
    LAST30DAYS_URL: c.env.LAST30DAYS_URL,
  }, trigger);

  return c.json({ status: "ok", signal_id: signalId, message: "Alert processed, Telegram sent" });
});

// ── Streaming Data Feed ───────────────────────────────────────────────────────

/**
 * Batch tick refresh endpoint — called by the market-hours cron (every-5-min 13-20 UTC weekdays)
 * or directly from TOS AutoHotkey on a timer.
 *
 * Body: { ticks: TickData[] }
 * Returns: how many positions updated + any threshold alerts fired
 */
twsRouter.post("/api/tws/stream", async (c) => {
  const body = await c.req.json<{ ticks?: TickData[] }>();
  const ticks = body.ticks ?? [];

  if (ticks.length === 0) {
    // No ticks provided — return current watchlist for TOS to populate
    const watchlist = await getActiveWatchlist(c.env.DB);
    return c.json({ status: "ready", watchlist, message: "Send ticks array with prices for these symbols" });
  }

  const result = await refreshStreamingData(c.env.DB, {
    TRADING_URL: c.env.TRADING_URL,
    TELEGRAM_BOT_TOKEN: c.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: c.env.TELEGRAM_CHAT_ID,
  }, ticks);

  return c.json({ status: "ok", ...result });
});

// ── Backtest Validator ────────────────────────────────────────────────────────

/**
 * Submit TOS backtest results for skill creation via hermes-api.
 *
 * TOS Export Steps:
 *   1. Strategy → Backtest → Reports → Export to CSV
 *   2. Pass CSV data as JSON via this endpoint
 *   3. bot-nation sends to hermes-api → creates reusable skill in D1
 *
 * Body: BacktestExport object
 */
twsRouter.post("/api/tws/backtest", async (c) => {
  const data = await c.req.json<BacktestExport>();

  if (!data.symbol || !data.strategy) {
    return c.json({ error: "symbol and strategy required" }, 400);
  }

  // Defaults for optional fields
  data.total_trades = data.total_trades ?? 0;
  data.win_rate     = data.win_rate     ?? 0;
  data.avg_profit   = data.avg_profit   ?? 0;
  data.max_drawdown = data.max_drawdown ?? 0;
  data.trades       = data.trades       ?? [];

  const result = await validateBacktest(
    c.env.DB,
    c.env.HERMES_API_URL,
    data,
  );

  return c.json({
    status: "ok",
    backtest_id: result.backtestId,
    skill_id: result.skillId,
    summary: result.summary,
    message: result.skillId
      ? `Skill created: ${result.skillId}`
      : "Backtest stored. Skill creation pending (hermes-api unavailable).",
  });
});

// ── Order Entry Integration ───────────────────────────────────────────────────

/**
 * Get agent-consensus order parameters for a trade.
 * Returns pre-populated entry/exit/stop ready to paste into TOS Order Entry.
 *
 * ThinkScript / AHK Usage:
 *   1. Right-click symbol → "Get Bot Nation Analysis"
 *   2. POST { symbol, strategy, action, current_price }
 *   3. Response populates TOS order ticket via clipboard / AHK
 */
twsRouter.post("/api/tws/order-entry", async (c) => {
  const req = await c.req.json<OrderEntryRequest>();

  if (!req.symbol || !req.current_price) {
    return c.json({ error: "symbol and current_price required" }, 400);
  }

  req.strategy   = req.strategy   ?? "DIAGONAL";
  req.action     = req.action     ?? "OPEN";
  req.dte_target = req.dte_target ?? 30;

  const result = await generateOrderEntry(c.env.DB, c.env.TRADING_URL, req);

  // Format output for TOS order ticket (human + machine readable)
  const tosFormat = formatForTOS(req.symbol, result);

  return c.json({
    status: "ok",
    suggestion_id: result.suggestionId,
    symbol: req.symbol,
    strategy: req.strategy,
    action: req.action,
    legs: result.legs,
    pricing: {
      net_credit:  result.net_credit,
      net_debit:   result.net_debit,
      max_profit:  result.max_profit,
      max_loss:    result.max_loss,
      breakeven:   result.breakeven,
      risk_reward: result.risk_reward,
    },
    confidence: result.confidence,
    reasoning: result.reasoning,
    tos_order_string: tosFormat,   // copy-paste into TOS order entry
  });
});

// ── Read Endpoints ────────────────────────────────────────────────────────────

/** Current open positions with latest marks */
twsRouter.get("/api/tws/positions", async (c) => {
  const positions = await query(
    c.env.DB,
    `SELECT * FROM tws_positions WHERE status='open' ORDER BY
       CASE WHEN days_to_expiry IS NOT NULL THEN days_to_expiry ELSE 9999 END ASC,
       symbol ASC`,
    [],
  );
  return c.json({ positions });
});

/** Recent trading signals (last 20) */
twsRouter.get("/api/tws/signals", async (c) => {
  const symbol = c.req.query("symbol");
  const signals = await query(
    c.env.DB,
    symbol
      ? "SELECT * FROM tws_signals WHERE symbol=? ORDER BY created_at DESC LIMIT 20"
      : "SELECT * FROM tws_signals ORDER BY created_at DESC LIMIT 20",
    symbol ? [symbol] : [],
  );
  return c.json({ signals });
});

/** Active watchlist */
twsRouter.get("/api/tws/watchlist", async (c) => {
  const watchlist = await query(
    c.env.DB,
    "SELECT * FROM tws_watchlist WHERE active=1 ORDER BY symbol ASC",
    [],
  );
  return c.json({ watchlist });
});

/** Add symbol to watchlist */
twsRouter.post("/api/tws/watchlist", async (c) => {
  const body = await c.req.json<{ symbol: string; asset_type?: string; notes?: string }>();
  if (!body.symbol) return c.json({ error: "symbol required" }, 400);
  const id   = crypto.randomUUID();
  const now  = new Date().toISOString();
  await run(
    c.env.DB,
    `INSERT OR IGNORE INTO tws_watchlist (id, symbol, asset_type, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, body.symbol.toUpperCase(), body.asset_type ?? "equity", body.notes ?? null, now, now],
  );
  return c.json({ status: "ok", id, symbol: body.symbol.toUpperCase() });
});

/** Update position (called after TOS position sync) */
twsRouter.patch("/api/tws/positions/:id", async (c) => {
  const id   = c.req.param("id");
  const body = await c.req.json<{
    mark?: number; pl_open?: number; pl_pct?: number; days_to_expiry?: number; status?: string;
  }>();
  const now = new Date().toISOString();
  const fields: string[] = [];
  const vals: (string | number | null)[] = [];
  if (body.mark          !== undefined) { fields.push("mark=?");          vals.push(body.mark); }
  if (body.pl_open       !== undefined) { fields.push("pl_open=?");       vals.push(body.pl_open); }
  if (body.pl_pct        !== undefined) { fields.push("pl_pct=?");        vals.push(body.pl_pct); }
  if (body.days_to_expiry!== undefined) { fields.push("days_to_expiry=?");vals.push(body.days_to_expiry); }
  if (body.status        !== undefined) { fields.push("status=?");        vals.push(body.status); }
  if (fields.length === 0) return c.json({ error: "no fields to update" }, 400);
  fields.push("updated_at=?"); vals.push(now); vals.push(id);
  await run(c.env.DB, `UPDATE tws_positions SET ${fields.join(",")} WHERE id=?`, vals);
  return c.json({ status: "ok", id });
});

/** Portfolio summary — overall P/L, risk exposure */
twsRouter.get("/api/tws/portfolio", async (c) => {
  const positions = await query<{
    symbol: string; strategy: string; side: string; strike: number; expiry: string;
    days_to_expiry: number; pl_open: number; pl_pct: number; mark: number; alert_note: string;
  }>(
    c.env.DB,
    "SELECT symbol, strategy, side, strike, expiry, days_to_expiry, pl_open, pl_pct, mark, alert_note FROM tws_positions WHERE status='open'",
    [],
  );

  const totalPLOpen = positions.reduce((s, p) => s + (p.pl_open ?? 0), 0);
  const urgentPositions = positions.filter((p) => p.days_to_expiry !== null && p.days_to_expiry <= 7);
  const signals = await query<{ symbol: string; signal_type: string; confidence: number }>(
    c.env.DB,
    "SELECT symbol, signal_type, confidence FROM tws_signals ORDER BY created_at DESC LIMIT 5",
    [],
  );

  return c.json({
    summary: {
      open_positions: positions.length,
      total_pl_open: totalPLOpen,
      urgent_expirations: urgentPositions.length,
    },
    urgent: urgentPositions,
    positions,
    recent_signals: signals,
  });
});

// ── TOS Integration Helper ────────────────────────────────────────────────────

/**
 * Formats order suggestion as a TOS-compatible order string.
 * Can be copied directly into TOS Order Entry or sent via AutoHotkey.
 */
function formatForTOS(symbol: string, result: { legs: Array<{
  action: string; qty_effect: string; option_type: string;
  strike: number; expiry: string; dte: number; rationale: string;
}>; net_credit: number | null; confidence: number }): string {
  const legs = result.legs.map((leg) =>
    `${leg.action} +1 ${leg.qty_effect} ${symbol} ${leg.expiry} ${leg.strike} ${leg.option_type}`,
  ).join(" / ");
  const price = result.net_credit !== null
    ? `LMT ${result.net_credit > 0 ? "CREDIT" : "DEBIT"} $${Math.abs(result.net_credit).toFixed(2)}`
    : "";
  return `${legs} ${price} GTC [confidence: ${(result.confidence * 100).toFixed(0)}%]`;
}
