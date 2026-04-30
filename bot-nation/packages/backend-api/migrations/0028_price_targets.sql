CREATE TABLE IF NOT EXISTS price_targets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  symbol TEXT NOT NULL,
  trend TEXT NOT NULL CHECK(trend IN ('BULLISH','BEARISH','NEUTRAL')),
  daily_target REAL,
  weekly_target REAL,
  support REAL,
  resistance REAL,
  confidence REAL DEFAULT 0.5,
  current_price REAL,
  reasoning TEXT,
  generated_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_price_targets_symbol ON price_targets(symbol);
CREATE INDEX IF NOT EXISTS idx_price_targets_generated ON price_targets(generated_at DESC);
