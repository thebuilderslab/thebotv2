-- 0024: thinkorswim Integration — Phase 1
-- Features: WebSocket Bridge, Watchlist Alerts, Streaming Data Feed,
--           Backtest Validator, Order Entry Integration
-- Seeded with current portfolio snapshot (Apr 16 2026)

-- ── 1. Watchlist — symbols under active monitoring ────────────────────────────
CREATE TABLE IF NOT EXISTS tws_watchlist (
  id         TEXT PRIMARY KEY,
  symbol     TEXT NOT NULL UNIQUE,
  asset_type TEXT NOT NULL DEFAULT 'equity',  -- equity | option | etf
  notes      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tws_watchlist_symbol ON tws_watchlist(symbol);
CREATE INDEX IF NOT EXISTS idx_tws_watchlist_active ON tws_watchlist(active);

-- ── 2. Positions — open positions synced from TOS ─────────────────────────────
CREATE TABLE IF NOT EXISTS tws_positions (
  id              TEXT PRIMARY KEY,
  symbol          TEXT NOT NULL,
  strategy        TEXT,                   -- DIAGONAL | VERTICAL | NAKED | LONG
  side            TEXT NOT NULL,          -- LONG | SHORT
  option_type     TEXT,                   -- CALL | PUT | null (stock)
  strike          REAL,
  expiry          TEXT,
  quantity        INTEGER NOT NULL DEFAULT 1,
  trade_price     REAL,
  mark            REAL,
  pl_open         REAL,
  pl_pct          REAL,
  days_to_expiry  INTEGER,
  status          TEXT NOT NULL DEFAULT 'open',  -- open | closed | expired
  alert_note      TEXT,                   -- bot-nation analysis note
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tws_positions_symbol ON tws_positions(symbol);
CREATE INDEX IF NOT EXISTS idx_tws_positions_status ON tws_positions(status);
CREATE INDEX IF NOT EXISTS idx_tws_positions_expiry ON tws_positions(expiry);

-- ── 3. Signals — multi-agent trading signals ─────────────────────────────────
CREATE TABLE IF NOT EXISTS tws_signals (
  id                TEXT PRIMARY KEY,
  symbol            TEXT NOT NULL,
  signal_type       TEXT NOT NULL,  -- BUY | SELL | HOLD | ROLL | CLOSE | WATCH
  confidence        REAL,           -- 0.0 – 1.0
  entry_price       REAL,
  target_price      REAL,
  stop_price        REAL,
  position_size_pct REAL,           -- % of portfolio
  reasoning         TEXT,           -- JSON: {fundamental, technical, sentiment, risk}
  agents_consensus  INTEGER,        -- how many of 4 agents agree
  source_task_id    TEXT,           -- FK tasks(id) that produced this signal
  timeframe         TEXT,           -- intraday | swing | long-term
  expires_at        TEXT,           -- signal validity window
  acted_on          INTEGER DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tws_signals_symbol ON tws_signals(symbol);
CREATE INDEX IF NOT EXISTS idx_tws_signals_created ON tws_signals(created_at DESC);

-- ── 4. Alerts — TOS price-zone triggers ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS tws_alerts (
  id           TEXT PRIMARY KEY,
  symbol       TEXT NOT NULL,
  trigger_type TEXT NOT NULL,  -- PRICE_CROSS | PRICE_TOUCH | RSI | MACD | VOLUME
  trigger_val  REAL,
  direction    TEXT,           -- ABOVE | BELOW
  triggered_at TEXT,
  signal_id    TEXT,           -- FK tws_signals(id) generated on trigger
  message_sent INTEGER DEFAULT 0,  -- 1 if Telegram notification sent
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tws_alerts_symbol ON tws_alerts(symbol);
CREATE INDEX IF NOT EXISTS idx_tws_alerts_triggered ON tws_alerts(triggered_at DESC);

-- ── 5. Order suggestions — pre-populated order params from agent consensus ────
CREATE TABLE IF NOT EXISTS tws_order_suggestions (
  id              TEXT PRIMARY KEY,
  symbol          TEXT NOT NULL,
  strategy        TEXT NOT NULL,  -- DIAGONAL | VERTICAL | BUY_WRITE | NAKED_PUT
  action          TEXT NOT NULL,  -- OPEN | CLOSE | ROLL
  legs            TEXT NOT NULL,  -- JSON array of legs
  net_credit      REAL,
  net_debit       REAL,
  max_profit      REAL,
  max_loss        REAL,
  breakeven       REAL,
  risk_reward     REAL,
  confidence      REAL,
  signal_id       TEXT,
  executed        INTEGER DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── 6. Backtest results — exported TOS backtests sent to hermes for skill creation ──
CREATE TABLE IF NOT EXISTS tws_backtests (
  id           TEXT PRIMARY KEY,
  symbol       TEXT NOT NULL,
  strategy     TEXT NOT NULL,
  start_date   TEXT,
  end_date     TEXT,
  total_trades INTEGER,
  win_rate     REAL,
  avg_profit   REAL,
  max_drawdown REAL,
  sharpe       REAL,
  raw_data     TEXT,         -- JSON export from TOS
  skill_id     TEXT,         -- FK skills(id) created by hermes
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | skill_created | failed
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ── 7. WebSocket sessions — active TOS bridge connections ────────────────────
CREATE TABLE IF NOT EXISTS tws_ws_sessions (
  id           TEXT PRIMARY KEY,
  client_label TEXT,                   -- e.g. "thinkorswim-desktop"
  status       TEXT DEFAULT 'active',  -- active | disconnected
  last_ping    TEXT,
  symbols      TEXT,                   -- JSON array of subscribed symbols
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────────────────────────────────────
-- SEED: Current portfolio (Apr 16 2026 snapshot from thinkorswim)
-- ─────────────────────────────────────────────────────────────────────────────

INSERT OR IGNORE INTO tws_watchlist (id, symbol, asset_type, notes) VALUES
  ('wl-tsla', 'TSLA',  'equity', 'Diagonal spread active. Resistance 408, Support 337.24. RSI 56.48 neutral, MACD bearish-flattening.'),
  ('wl-spy',  'SPY',   'etf',    'Diagonal spread active. RSI 82.47 overbought on 4H. Resistance 702.78. Watch for reversal.'),
  ('wl-googl','GOOGL', 'equity', 'Diagonal spread active. RSI 69.84 near overbought. 340C short expires Apr 24 — 8 days. Priority roll/exit.'),
  ('wl-orcl', 'ORCL',  'equity', 'Monitoring only. RSI 70.44 at overbought threshold. MACD bullish divergence. No current position. Alert levels: 330.63, 215.41, 156.19, 128.08.');

-- Current open positions
INSERT OR IGNORE INTO tws_positions (id, symbol, strategy, side, option_type, strike, expiry, quantity, trade_price, mark, pl_open, pl_pct, days_to_expiry, status, alert_note) VALUES
  -- GOOGL SHORT LEG (priority — expires Apr 24, 8 DTE, stock at 335.70 vs 340 strike)
  ('pos-googl-short', 'GOOGL', 'DIAGONAL', 'SHORT', 'CALL', 340.0, '2026-04-24', 1, 1.41, 4.350, 293.34, 2.07, 8, 'open',
   'PRIORITY: Short 340C expires Apr 24 (8 DTE). Stock at 335.70, $4.30 OTM. Mark 4.35 vs trade 1.41. Consider rolling to May or closing short leg.'),
  -- GOOGL LONG LEG
  ('pos-googl-long', 'GOOGL', 'DIAGONAL', 'LONG', 'CALL', 365.0, '2026-05-08', 1, NULL, NULL, NULL, NULL, 22, 'open', NULL),

  -- SPY SHORT LEG (overbought RSI 82.47 — monitor for roll)
  ('pos-spy-short', 'SPY', 'DIAGONAL', 'SHORT', 'CALL', 815.0, '2026-07-17', 1, 0.25, 0.235, -1.50, -0.06, 92, 'open',
   'SPY RSI 82.47 overbought on 4H. Short 815C Jul 17 (92 DTE) at mark 0.235. P/L -$1.50. Monitor for mean reversion.'),
  -- SPY LONG LEG (working order)
  ('pos-spy-long', 'SPY', 'DIAGONAL', 'LONG', 'CALL', 925.0, '2026-12-18', 1, NULL, NULL, NULL, NULL, 246, 'open', NULL),

  -- TSLA SHORT LEG
  ('pos-tsla-short', 'TSLA', 'DIAGONAL', 'SHORT', 'CALL', 530.0, '2026-05-01', 1, 0.32, 0.340, 2.00, 0.0625, 15, 'open',
   'TSLA RSI 56.48 neutral, MACD -6.23 bearish but flattening. Short 530C May 1 (15 DTE), 140pt OTM. P/L +$2.00. Healthy.'),
  -- TSLA LONG LEG (working order)
  ('pos-tsla-long', 'TSLA', 'DIAGONAL', 'LONG', 'CALL', 575.0, '2026-05-08', 1, NULL, NULL, NULL, NULL, 22, 'open', NULL),

  -- ORCL watch (RSI 70.44 at threshold)
  ('pos-orcl-watch', 'ORCL', 'WATCH', 'LONG', NULL, NULL, NULL, 0, NULL, 178.25, NULL, NULL, NULL, 'open',
   'ORCL RSI 70.44 exactly at overbought. MACD bullish divergence 2.85/3.98. Resistance 345.72, Support 134.57. Wait for RSI pullback to 55-60 before entry.');

-- Seed active TOS price alerts
INSERT OR IGNORE INTO tws_alerts (id, symbol, trigger_type, trigger_val, direction, created_at) VALUES
  ('alert-googl-1', 'GOOGL', 'PRICE_CROSS', 321.63, 'BELOW', datetime('now')),
  ('alert-googl-2', 'GOOGL', 'PRICE_CROSS', 305.68, 'BELOW', datetime('now')),
  ('alert-googl-3', 'GOOGL', 'PRICE_CROSS', 288.11, 'BELOW', datetime('now')),
  ('alert-googl-4', 'GOOGL', 'PRICE_CROSS', 261.85, 'BELOW', datetime('now')),
  ('alert-googl-5', 'GOOGL', 'PRICE_CROSS', 235.67, 'BELOW', datetime('now')),
  ('alert-googl-6', 'GOOGL', 'PRICE_CROSS', 212.08, 'BELOW', datetime('now')),
  ('alert-spy-1',   'SPY',   'PRICE_CROSS', 659.73, 'BELOW', datetime('now')),
  ('alert-orcl-1',  'ORCL',  'PRICE_CROSS', 330.63, 'ABOVE', datetime('now')),
  ('alert-orcl-2',  'ORCL',  'PRICE_CROSS', 215.41, 'ABOVE', datetime('now')),
  ('alert-orcl-3',  'ORCL',  'PRICE_CROSS', 156.19, 'BELOW', datetime('now')),
  ('alert-orcl-4',  'ORCL',  'PRICE_CROSS', 128.08, 'BELOW', datetime('now'));

-- Seed finance team research tasks for current positions
INSERT OR IGNORE INTO tasks (id, kind, status, assigned_agent_id, team_id, input, created_at, updated_at) VALUES
  (
    'task-tws-googl-urgent',
    'research',
    'pending',
    'agent-finance-lead',
    'team-finance',
    '{"summary":"URGENT: GOOGL Apr 24 340 CALL exit strategy","details":"GOOGL short 340 call expires Apr 24 (8 DTE). Current stock price ~335.70. Strike is $4.30 OTM. Mark is 4.35 vs original trade price 1.41. P/L +$293. Options: (1) Hold to expiry — 8 days, stock must stay below 340; (2) Close short leg now — buy back at 4.35 mark; (3) Roll to May 8 365C diagonal. Analyze RSI 69.84 (near overbought), MACD 7.41/2.18 (bullish), volume 13.6M. Recommend exit strategy with specific strikes and timing."}',
    datetime('now'),
    datetime('now')
  ),
  (
    'task-tws-spy-overbought',
    'research',
    'pending',
    'agent-finance-lead',
    'team-finance',
    '{"summary":"SPY RSI 82 overbought — assess diagonal spread risk","details":"SPY at 701.54 on 4H chart showing RSI 82.47 — significantly overbought. Short leg: 815C Jul 17 (92 DTE) at mark 0.235, trade 0.25. Long leg working order: 925C Dec 18. MACD 6.25 bullish but signal line flat at -0.038. Resistance 702.78 (current high). Assess: (1) Is reversal risk high enough to roll/close short? (2) If SPY drops, what target entries for long leg? (3) What RSI level signals safe re-entry? Provide probability of touch analysis for 815C."}',
    datetime('now'),
    datetime('now')
  ),
  (
    'task-tws-orcl-entry',
    'research',
    'pending',
    'agent-finance-lead',
    'team-finance',
    '{"summary":"ORCL entry analysis — RSI at 70 threshold","details":"ORCL at 178.25. RSI exactly 70.44 — at overbought threshold. MACD bullish divergence: fast 2.85, signal -1.10, histogram 3.98. 1Y chart shows price well below prior highs of 345.72. Support at 134.57. Alerts set at 330.63 (resistance), 215.41, 156.19, 128.08. Analyze: (1) Is this RSI peak or continuation? (2) Optimal diagonal spread setup if entering long (strikes, expiry, credit target); (3) Entry trigger — wait for RSI pullback to 55-60 or buy strength? (4) Position sizing given current portfolio."}',
    datetime('now'),
    datetime('now')
  ),
  (
    'task-tws-tsla-monitor',
    'research',
    'pending',
    'agent-finance-lead',
    'team-finance',
    '{"summary":"TSLA diagonal spread health check","details":"TSLA at 389.53. Diagonal spread: short 530C May 1 (15 DTE, 140pt OTM), long 575C May 8. Short leg mark 0.340 vs trade 0.32, P/L +$2. RSI 56.48 neutral, MACD -6.23/-10.92 bearish but flattening (potential reversal). Resistance ~408, support 337.24. Volume 56.7M. Assess: (1) Is 530C strike safe with 15 DTE given bearish MACD? (2) Should long leg be opened at current price? (3) If TSLA breaks above 408 resistance, what adjustment is needed? (4) Provide updated P/L projections at current IV."}',
    datetime('now'),
    datetime('now')
  ),
  (
    'task-tws-portfolio-risk',
    'research',
    'pending',
    'agent-finance-lead',
    'team-finance',
    '{"summary":"Full portfolio risk assessment — 4 diagonals","details":"Current portfolio: GOOGL diagonal (340/365C, Apr/May), SPY diagonal (815/925C, Jul/Dec), TSLA diagonal (530/575C, May1/May8), ORCL watching. Overall P/L: +147.91% = +$293.84. Day P/L: -$121.27. Assess: (1) Correlation risk — GOOGL + SPY both near overbought; (2) Net delta exposure across all positions; (3) Upcoming expiry risk (GOOGL Apr 24 is most urgent); (4) If market drops 5%, what is portfolio impact? (5) Recommended portfolio adjustments."}',
    datetime('now'),
    datetime('now')
  );
