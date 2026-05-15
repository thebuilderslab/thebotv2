-- 0044: Greeks + IV enrichment columns + watchlist_snapshots table
-- Supports Phase A.6 (Layer 2 of the Finance-Intelligence layered recommendation engine).
-- A.6 fills these columns at EOD by fetching Schwab options chain rows for held
-- option positions and Schwab quotes for active watchlist symbols.
-- All enrichment uses exact-match on (underlying, strike, expiry, option_type).
-- If exact-match fails, the snapshot row is still written with enrichment_failed=1
-- and all Greek/IV fields NULL (no fuzzy matching anywhere).

-- ── 1. Extend position_snapshots with gamma + IV + enrichment audit fields ──
ALTER TABLE position_snapshots ADD COLUMN gamma REAL;
ALTER TABLE position_snapshots ADD COLUMN implied_volatility REAL;
ALTER TABLE position_snapshots ADD COLUMN enrichment_method TEXT;
ALTER TABLE position_snapshots ADD COLUMN enrichment_failed INTEGER NOT NULL DEFAULT 0;

-- ── 2. Watchlist snapshot table — daily close + volume for active tws_watchlist symbols
CREATE TABLE IF NOT EXISTS watchlist_snapshots (
  id           TEXT PRIMARY KEY,
  symbol       TEXT NOT NULL,
  close_price  REAL NOT NULL,
  volume       INTEGER,
  recorded_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_watchlist_snapshots_symbol_date
  ON watchlist_snapshots(symbol, recorded_at DESC);

-- One row per (symbol, trading day). Prevents duplicate EOD inserts.
CREATE UNIQUE INDEX IF NOT EXISTS uq_watchlist_snapshots_symbol_day
  ON watchlist_snapshots(symbol, date(recorded_at));
