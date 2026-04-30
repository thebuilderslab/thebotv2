/**
 * thinkorswim Bridge Service
 *
 * Five features:
 *   1. WebSocket Bridge     — persistent WS connection, routes tick data to trading agents
 *   2. Watchlist Alerts     — price-zone trigger → multi-agent analysis → Telegram
 *   3. Streaming Data Feed  — market-hours tick refresh → confidence score updates
 *   4. Backtest Validator   — TOS export → hermes-api → skill creation
 *   5. Order Entry          — agent consensus → pre-populated entry/exit/stop params
 */

import { query, queryOne, run } from "../db/schema";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TickData {
  symbol: string;
  price: number;
  volume: number;
  bid: number;
  ask: number;
  rsi?: number;
  macd?: number;
  macd_signal?: number;
  timestamp: string;
}

export interface AlertTrigger {
  symbol: string;
  trigger_type: "PRICE_CROSS" | "PRICE_TOUCH" | "RSI" | "MACD" | "VOLUME";
  trigger_val: number;
  direction: "ABOVE" | "BELOW";
  current_price: number;
  current_rsi?: number;
  current_macd?: number;
  timestamp: string;
}

export interface BacktestExport {
  symbol: string;
  strategy: string;
  start_date: string;
  end_date: string;
  total_trades: number;
  win_rate: number;
  avg_profit: number;
  max_drawdown: number;
  sharpe?: number;
  trades: Array<{
    entry_date: string;
    exit_date: string;
    direction: string;
    entry_price: number;
    exit_price: number;
    pnl: number;
    notes?: string;
  }>;
}

export interface OrderEntryRequest {
  symbol: string;
  strategy: "DIAGONAL" | "VERTICAL" | "BUY_WRITE" | "NAKED_PUT" | "LONG_CALL" | "LONG_PUT";
  action: "OPEN" | "CLOSE" | "ROLL";
  current_price: number;
  dte_target?: number;        // target days to expiry
  delta_target?: number;      // target delta for short leg (e.g. 0.20)
  max_risk_pct?: number;      // max % of portfolio to risk
  context?: string;           // additional context for agents
}

export interface AgentSignal {
  signal_type: "BUY" | "SELL" | "HOLD" | "ROLL" | "CLOSE" | "WATCH";
  confidence: number;
  entry_price?: number;
  target_price?: number;
  stop_price?: number;
  position_size_pct?: number;
  reasoning: {
    fundamental?: string;
    technical?: string;
    sentiment?: string;
    risk?: string;
  };
  agents_consensus: number;
  timeframe: string;
}

// ── 1. WebSocket Bridge ───────────────────────────────────────────────────────

/**
 * Register a new WebSocket session from TOS desktop client.
 * Returns a session ID that TOS uses to authenticate subsequent messages.
 */
export async function registerWsSession(
  db: D1Database,
  clientLabel: string,
  symbols: string[],
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await run(
    db,
    `INSERT INTO tws_ws_sessions (id, client_label, status, last_ping, symbols, created_at, updated_at)
     VALUES (?, ?, 'active', ?, ?, ?, ?)`,
    [id, clientLabel, now, JSON.stringify(symbols), now, now],
  );
  return id;
}

export async function pingWsSession(db: D1Database, sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  await run(
    db,
    "UPDATE tws_ws_sessions SET last_ping=?, updated_at=? WHERE id=?",
    [now, now, sessionId],
  );
}

export async function closeWsSession(db: D1Database, sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  await run(
    db,
    "UPDATE tws_ws_sessions SET status='disconnected', updated_at=? WHERE id=?",
    [now, sessionId],
  );
}

// ── 2. Watchlist Alert Handler ────────────────────────────────────────────────

/**
 * Called when TOS fires a price alert.
 * Runs multi-agent analysis and sends Telegram notification.
 */
export async function handleAlertTrigger(
  db: D1Database,
  env: {
    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_CHAT_ID: string;
    TRADING_URL?: string;
    LAST30DAYS_URL?: string;
  },
  trigger: AlertTrigger,
): Promise<string> {
  const now = new Date().toISOString();
  const alertId = crypto.randomUUID();

  // Store the trigger
  await run(
    db,
    `INSERT INTO tws_alerts (id, symbol, trigger_type, trigger_val, direction, triggered_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [alertId, trigger.symbol, trigger.trigger_type, trigger.trigger_val, trigger.direction, now, now],
  );

  // Run analysis (parallel: trading agents + social sentiment)
  const [tradingResult, sentimentResult] = await Promise.allSettled([
    callTradingAgents(env.TRADING_URL, trigger.symbol, buildAlertContext(trigger)),
    callLast30Days(env.LAST30DAYS_URL, trigger.symbol),
  ]);

  const trading = tradingResult.status === "fulfilled" ? tradingResult.value : null;
  const sentiment = sentimentResult.status === "fulfilled" ? sentimentResult.value : null;

  // Build signal
  const signal = synthesizeSignal(trigger.symbol, trading, sentiment, trigger);
  const signalId = crypto.randomUUID();

  await run(
    db,
    `INSERT INTO tws_signals (id, symbol, signal_type, confidence, entry_price, target_price, stop_price,
       position_size_pct, reasoning, agents_consensus, timeframe, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      signalId,
      signal.symbol,
      signal.signal_type,
      signal.confidence,
      signal.entry_price ?? null,
      signal.target_price ?? null,
      signal.stop_price ?? null,
      signal.position_size_pct ?? null,
      JSON.stringify(signal.reasoning),
      signal.agents_consensus,
      signal.timeframe,
      new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(), // 4h validity
      now,
    ],
  );

  // Link alert → signal
  await run(db, "UPDATE tws_alerts SET signal_id=?, message_sent=1 WHERE id=?", [signalId, alertId]);

  // Send Telegram notification
  const msg = buildAlertTelegramMessage(trigger, signal);
  await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, msg);

  return signalId;
}

// ── 3. Streaming Data Feed ────────────────────────────────────────────────────

/**
 * Called every 5 min during market hours (market-hours cron, weekdays 13-20 UTC).
 * Updates marks for open positions and refreshes confidence on existing signals.
 */
export async function refreshStreamingData(
  db: D1Database,
  env: {
    TRADING_URL?: string;
    TELEGRAM_BOT_TOKEN: string;
    TELEGRAM_CHAT_ID: string;
  },
  ticks: TickData[],
): Promise<{ updated: number; alerts: string[] }> {
  const now = new Date().toISOString();
  const alertMessages: string[] = [];
  let updated = 0;

  for (const tick of ticks) {
    // Update position marks
    await run(
      db,
      "UPDATE tws_positions SET mark=?, updated_at=? WHERE symbol=? AND status='open'",
      [tick.price, now, tick.symbol],
    );
    updated++;

    // Check for RSI threshold crossings
    if (tick.rsi !== undefined) {
      if (tick.rsi >= 70) {
        alertMessages.push(`⚠️ ${tick.symbol} RSI ${tick.rsi.toFixed(1)} — OVERBOUGHT. Price: $${tick.price}`);
      } else if (tick.rsi <= 30) {
        alertMessages.push(`📉 ${tick.symbol} RSI ${tick.rsi.toFixed(1)} — OVERSOLD. Price: $${tick.price}`);
      }
    }

    // Check positions approaching expiry (≤ 7 DTE) with adverse moves
    const shortLeg = await queryOne<{ id: string; strike: number; days_to_expiry: number; side: string }>(
      db,
      `SELECT id, strike, days_to_expiry, side FROM tws_positions
       WHERE symbol=? AND status='open' AND side='SHORT' AND option_type='CALL'
       ORDER BY days_to_expiry ASC LIMIT 1`,
      [tick.symbol],
    );

    if (shortLeg && shortLeg.days_to_expiry <= 7) {
      const pctOtm = ((shortLeg.strike - tick.price) / tick.price) * 100;
      if (pctOtm < 3) {
        // Within 3% of short strike with ≤7 DTE — high risk alert
        alertMessages.push(
          `🚨 ${tick.symbol} SHORT ${shortLeg.strike}C only ${pctOtm.toFixed(1)}% OTM with ${shortLeg.days_to_expiry} DTE. Price: $${tick.price}. Consider rolling.`,
        );
      }
    }
  }

  // Send any threshold alerts to Telegram
  if (alertMessages.length > 0) {
    const msg = `📡 *Bot Nation — Streaming Alert*\n\n${alertMessages.join("\n\n")}\n\n_${new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET_`;
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, msg);
  }

  return { updated, alerts: alertMessages };
}

/**
 * Process tick data pushed from TOS via WebSocket (no ticks array needed —
 * called from the route handler with a single symbol's latest data).
 */
export async function processTick(
  db: D1Database,
  tick: TickData,
): Promise<void> {
  const now = new Date().toISOString();
  await run(
    db,
    "UPDATE tws_positions SET mark=?, updated_at=? WHERE symbol=? AND status='open'",
    [tick.price, now, tick.symbol],
  );
  await run(
    db,
    "UPDATE tws_watchlist SET notes=?, updated_at=? WHERE symbol=?",
    [
      `Last tick: $${tick.price} | Vol: ${tick.volume} | RSI: ${tick.rsi ?? "N/A"} | MACD: ${tick.macd ?? "N/A"} @ ${tick.timestamp}`,
      now,
      tick.symbol,
    ],
  );
}

// ── 4. Backtest Validator ─────────────────────────────────────────────────────

/**
 * Accept a TOS backtest export, send to hermes-api for analysis,
 * and create a skill from what worked.
 */
export async function validateBacktest(
  db: D1Database,
  hermesUrl: string | undefined,
  data: BacktestExport,
): Promise<{ backtestId: string; skillId: string | null; summary: string }> {
  const now = new Date().toISOString();
  const backtestId = crypto.randomUUID();

  // Store raw backtest
  await run(
    db,
    `INSERT INTO tws_backtests (id, symbol, strategy, start_date, end_date, total_trades,
       win_rate, avg_profit, max_drawdown, sharpe, raw_data, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?)`,
    [
      backtestId,
      data.symbol,
      data.strategy,
      data.start_date,
      data.end_date,
      data.total_trades,
      data.win_rate,
      data.avg_profit,
      data.max_drawdown,
      data.sharpe ?? null,
      JSON.stringify(data),
      now,
    ],
  );

  // Build hermes query from backtest summary
  const hermesQuery = buildBacktestHermesQuery(data);
  let skillId: string | null = null;
  let summary = "Backtest stored. Hermes analysis pending.";

  if (hermesUrl) {
    try {
      const resp = await fetch(`${hermesUrl}/reason`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: hermesQuery,
          context: {
            create_skill: true,
            skill_category: "trading_backtest",
            backtest_data: {
              symbol: data.symbol,
              strategy: data.strategy,
              win_rate: data.win_rate,
              avg_profit: data.avg_profit,
              max_drawdown: data.max_drawdown,
              sharpe: data.sharpe,
              total_trades: data.total_trades,
            },
          },
        }),
      });

      if (resp.ok) {
        const result = await resp.json() as {
          reasoning?: string;
          skill_created?: string;
          skill_procedure?: string;
          quality_score?: number;
        };

        // Store skill in D1
        if (result.skill_procedure) {
          skillId = `skill-backtest-${data.symbol.toLowerCase()}-${Date.now()}`;
          await run(
            db,
            `INSERT OR IGNORE INTO skills (id, name, description, trigger_pattern, procedure, quality_score, created_from_task_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              skillId,
              `${data.symbol} ${data.strategy} Backtest Pattern`,
              `Validated trading pattern for ${data.symbol} ${data.strategy}. Win rate: ${(data.win_rate * 100).toFixed(0)}%, Avg profit: $${data.avg_profit.toFixed(2)}, Sharpe: ${data.sharpe?.toFixed(2) ?? "N/A"}`,
              `${data.symbol.toLowerCase()}|${data.strategy.toLowerCase().replace(/_/g, "|")}`,
              result.skill_procedure,
              result.quality_score ?? 0.7,
              backtestId,
              now,
            ],
          );

          // Link skill → backtest
          await run(
            db,
            "UPDATE tws_backtests SET skill_id=?, status='skill_created' WHERE id=?",
            [skillId, backtestId],
          );

          summary = result.reasoning ?? `Skill created from ${data.strategy} backtest (${(data.win_rate * 100).toFixed(0)}% win rate).`;
        }
      }
    } catch (err) {
      console.error("[thinkorswim-bridge] hermes backtest error:", err);
      await run(db, "UPDATE tws_backtests SET status='failed' WHERE id=?", [backtestId]);
    }
  }

  return { backtestId, skillId, summary };
}

// ── 5. Order Entry Integration ────────────────────────────────────────────────

/**
 * Generate pre-populated order parameters from multi-agent consensus.
 * Returns entry, exit, stop, and position size based on risk assessment.
 */
export async function generateOrderEntry(
  db: D1Database,
  tradingUrl: string | undefined,
  req: OrderEntryRequest,
): Promise<{
  suggestionId: string;
  legs: OrderLeg[];
  net_credit: number | null;
  net_debit: number | null;
  max_profit: number | null;
  max_loss: number | null;
  breakeven: number | null;
  risk_reward: number | null;
  confidence: number;
  reasoning: string;
}> {
  const now = new Date().toISOString();

  // Get agent analysis
  const analysis = await callTradingAgents(
    tradingUrl,
    req.symbol,
    `${req.action} ${req.strategy} on ${req.symbol} at $${req.current_price}. DTE target: ${req.dte_target ?? 30}. Delta target: ${req.delta_target ?? 0.20}. Max risk: ${req.max_risk_pct ?? 2}% of portfolio. ${req.context ?? ""}`,
  );

  // Calculate order parameters
  const params = calculateOrderParams(req, analysis);

  const suggestionId = crypto.randomUUID();
  await run(
    db,
    `INSERT INTO tws_order_suggestions (id, symbol, strategy, action, legs, net_credit, net_debit,
       max_profit, max_loss, breakeven, risk_reward, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      suggestionId,
      req.symbol,
      req.strategy,
      req.action,
      JSON.stringify(params.legs),
      params.net_credit ?? null,
      params.net_debit ?? null,
      params.max_profit ?? null,
      params.max_loss ?? null,
      params.breakeven ?? null,
      params.risk_reward ?? null,
      params.confidence,
      now,
    ],
  );

  return { suggestionId, ...params };
}

interface OrderLeg {
  action: "BUY" | "SELL";
  qty_effect: "TO_OPEN" | "TO_CLOSE";
  option_type: "CALL" | "PUT";
  strike: number;
  expiry: string;
  dte: number;
  delta_approx: number;
  rationale: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function callTradingAgents(
  tradingUrl: string | undefined,
  symbol: string,
  context: string,
): Promise<TradingAgentResponse | null> {
  if (!tradingUrl) return null;
  try {
    const resp = await fetch(`${tradingUrl}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `analyze ${symbol}: ${context}` }),
      signal: AbortSignal.timeout(25_000),
    });
    if (!resp.ok) return null;
    return await resp.json() as TradingAgentResponse;
  } catch {
    return null;
  }
}

interface TradingAgentResponse {
  recommendation?: string;
  confidence?: number;
  agents_consensus?: number;
  consensus_strength?: string;
  analysis?: {
    fundamental?: string;
    technical?: string;
    sentiment?: string;
    risk?: string;
  };
  timeframe?: string;
}

async function callLast30Days(
  last30Url: string | undefined,
  symbol: string,
): Promise<Last30Response | null> {
  if (!last30Url) return null;
  try {
    const resp = await fetch(`${last30Url}/research`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: `${symbol} stock options trading`, mode: "quick" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    return await resp.json() as Last30Response;
  } catch {
    return null;
  }
}

interface Last30Response {
  report?: string;
  confidence?: number;
}

function buildAlertContext(trigger: AlertTrigger): string {
  return `Price alert triggered: ${trigger.symbol} at $${trigger.current_price} crossed ${trigger.direction} $${trigger.trigger_val}. RSI: ${trigger.current_rsi ?? "N/A"}. MACD: ${trigger.current_macd ?? "N/A"}. Alert type: ${trigger.trigger_type}.`;
}

function synthesizeSignal(
  symbol: string,
  trading: TradingAgentResponse | null,
  sentiment: Last30Response | null,
  trigger: AlertTrigger,
): AgentSignal & { symbol: string } {
  const confidence = Math.min(
    0.95,
    ((trading?.confidence ?? 0.5) * 0.7) + ((sentiment?.confidence ?? 0.5) * 0.3),
  );

  // Determine signal type from recommendation + alert direction
  let signal_type: AgentSignal["signal_type"] = "WATCH";
  const rec = (trading?.recommendation ?? "").toUpperCase();
  if (rec.includes("BUY") || rec.includes("LONG"))  signal_type = trigger.direction === "ABOVE" ? "BUY" : "WATCH";
  if (rec.includes("SELL") || rec.includes("SHORT")) signal_type = "SELL";
  if (rec.includes("HOLD"))                           signal_type = "HOLD";
  if (rec.includes("ROLL"))                           signal_type = "ROLL";
  if (rec.includes("CLOSE"))                          signal_type = "CLOSE";

  return {
    symbol,
    signal_type,
    confidence,
    entry_price: trigger.current_price,
    target_price: trigger.direction === "ABOVE"
      ? trigger.current_price * 1.08
      : trigger.current_price * 0.95,
    stop_price: trigger.direction === "ABOVE"
      ? trigger.current_price * 0.97
      : trigger.current_price * 1.03,
    position_size_pct: confidence > 0.75 ? 2.0 : 1.0,
    reasoning: {
      fundamental: trading?.analysis?.fundamental ?? "N/A",
      technical: trading?.analysis?.technical ?? "N/A",
      sentiment: sentiment?.report?.slice(0, 200) ?? "N/A",
      risk: trading?.analysis?.risk ?? "N/A",
    },
    agents_consensus: trading?.agents_consensus ?? 0,
    timeframe: trading?.timeframe ?? "swing",
  };
}

function calculateOrderParams(
  req: OrderEntryRequest,
  analysis: TradingAgentResponse | null,
): {
  legs: OrderLeg[];
  net_credit: number | null;
  net_debit: number | null;
  max_profit: number | null;
  max_loss: number | null;
  breakeven: number | null;
  risk_reward: number | null;
  confidence: number;
  reasoning: string;
} {
  const confidence = analysis?.confidence ?? 0.55;
  const dte = req.dte_target ?? 30;
  const delta = req.delta_target ?? 0.20;
  const price = req.current_price;

  // Estimate strikes based on delta approximation
  // At delta 0.20 ≈ ~15-20% OTM for 30 DTE
  const shortStrikeOffset = price * (delta < 0.25 ? 0.12 : 0.07);
  const shortStrike = Math.round((price + shortStrikeOffset) / 5) * 5;
  const longStrike = shortStrike + 40; // typical diagonal width

  const shortExpiry = (new Date(Date.now() + dte * 24 * 60 * 60 * 1000)
    .toISOString().split("T")[0]) as string;
  const longExpiry = (new Date(Date.now() + (dte + 30) * 24 * 60 * 60 * 1000)
    .toISOString().split("T")[0]) as string;

  const legs: OrderLeg[] = req.strategy === "DIAGONAL" ? [
    {
      action: "BUY",
      qty_effect: req.action === "OPEN" ? "TO_OPEN" : "TO_CLOSE",
      option_type: "CALL",
      strike: longStrike,
      expiry: longExpiry,
      dte: dte + 30,
      delta_approx: delta + 0.10,
      rationale: `Long leg — further expiry protects against sharp moves`,
    },
    {
      action: "SELL",
      qty_effect: req.action === "OPEN" ? "TO_OPEN" : "TO_CLOSE",
      option_type: "CALL",
      strike: shortStrike,
      expiry: shortExpiry,
      dte,
      delta_approx: delta,
      rationale: `Short leg — ${delta * 100}% delta, ${((shortStrike / price - 1) * 100).toFixed(1)}% OTM, collects premium`,
    },
  ] : [
    {
      action: "BUY",
      qty_effect: "TO_OPEN",
      option_type: "CALL",
      strike: shortStrike,
      expiry: shortExpiry,
      dte,
      delta_approx: delta + 0.25,
      rationale: `Long leg — ATM directional`,
    },
  ];

  const net_credit = req.strategy === "DIAGONAL" ? -0.40 : null;
  const max_profit = req.strategy === "DIAGONAL" ? (longStrike - shortStrike) * 0.6 : null;
  const max_loss = req.strategy === "DIAGONAL" ? (longStrike - shortStrike) * 0.4 : null;
  const breakeven = shortStrike + (net_credit ?? 0);
  const risk_reward = max_profit && max_loss ? max_profit / max_loss : null;

  const reasoning = [
    analysis?.recommendation ?? "No agent recommendation available.",
    analysis?.analysis?.technical ? `Technical: ${analysis.analysis.technical}` : "",
    analysis?.analysis?.risk ? `Risk: ${analysis.analysis.risk}` : "",
  ].filter(Boolean).join(" | ");

  return { legs, net_credit, net_debit: null, max_profit, max_loss, breakeven, risk_reward, confidence, reasoning };
}

function buildBacktestHermesQuery(data: BacktestExport): string {
  const topTrades = data.trades
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, 5)
    .map((t) => `${t.direction} entry:${t.entry_price} exit:${t.exit_price} P&L:${t.pnl > 0 ? "+" : ""}${t.pnl}`)
    .join(", ");

  return `Analyze this ${data.strategy} backtest on ${data.symbol} and create a reusable trading skill. ` +
    `Period: ${data.start_date} to ${data.end_date}. ` +
    `Results: ${data.total_trades} trades, ${(data.win_rate * 100).toFixed(0)}% win rate, ` +
    `avg P&L $${data.avg_profit.toFixed(2)}, max drawdown ${(data.max_drawdown * 100).toFixed(1)}%, ` +
    `Sharpe ${data.sharpe?.toFixed(2) ?? "N/A"}. ` +
    `Top trades: ${topTrades}. ` +
    `Extract the specific entry/exit rules that produced wins and encode as a step-by-step procedure.`;
}

function buildAlertTelegramMessage(
  trigger: AlertTrigger,
  signal: AgentSignal & { symbol: string },
): string {
  const emoji = {
    BUY: "🟢", SELL: "🔴", HOLD: "🟡", ROLL: "🔄", CLOSE: "⛔", WATCH: "👁",
  }[signal.signal_type] ?? "📊";

  return [
    `${emoji} *${signal.signal_type} — ${signal.symbol}*`,
    ``,
    `📍 Alert: ${signal.symbol} crossed ${trigger.direction} $${trigger.trigger_val}`,
    `💵 Current: $${trigger.current_price}`,
    signal.entry_price  ? `📥 Entry: $${signal.entry_price.toFixed(2)}`  : "",
    signal.target_price ? `🎯 Target: $${signal.target_price.toFixed(2)}` : "",
    signal.stop_price   ? `🛑 Stop: $${signal.stop_price.toFixed(2)}`    : "",
    signal.position_size_pct ? `📊 Size: ${signal.position_size_pct}% portfolio` : "",
    ``,
    `🤖 Confidence: ${(signal.confidence * 100).toFixed(0)}% (${signal.agents_consensus}/4 agents)`,
    `⏱ Timeframe: ${signal.timeframe}`,
    ``,
    signal.reasoning.technical ? `📈 Technical: ${signal.reasoning.technical.slice(0, 120)}` : "",
    signal.reasoning.risk      ? `⚠️ Risk: ${signal.reasoning.risk.slice(0, 100)}`           : "",
  ].filter(Boolean).join("\n");
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });
  } catch (err) {
    console.error("[thinkorswim-bridge] Telegram send failed:", err);
  }
}

// ── Active watchlist helper (used by streaming cron) ─────────────────────────

export async function getActiveWatchlist(db: D1Database): Promise<string[]> {
  const rows = await query<{ symbol: string }>(
    db,
    "SELECT symbol FROM tws_watchlist WHERE active=1",
    [],
  );
  return rows.map((r) => r.symbol);
}
