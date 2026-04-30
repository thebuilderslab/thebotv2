-- Migration 0030: Schwab account positions + account summaries

CREATE TABLE IF NOT EXISTS schwab_positions (
  id               TEXT PRIMARY KEY,
  account_number   TEXT NOT NULL,          -- last 4 digits only
  account_type     TEXT NOT NULL,          -- MARGIN, CASH, IRA, JOINT, etc.
  account_label    TEXT NOT NULL,          -- "Individual", "Roth IRA", "Joint Tenant"
  symbol           TEXT NOT NULL,
  asset_type       TEXT NOT NULL DEFAULT 'EQUITY',
  description      TEXT,
  quantity         REAL NOT NULL DEFAULT 0,
  average_price    REAL NOT NULL DEFAULT 0,
  market_value     REAL NOT NULL DEFAULT 0,
  cost_basis       REAL NOT NULL DEFAULT 0,
  unrealized_pnl   REAL NOT NULL DEFAULT 0,
  current_day_pnl  REAL NOT NULL DEFAULT 0,
  current_day_pnl_pct REAL NOT NULL DEFAULT 0,
  synced_at        TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schwab_positions_account ON schwab_positions(account_number);
CREATE INDEX IF NOT EXISTS idx_schwab_positions_symbol  ON schwab_positions(symbol);

CREATE TABLE IF NOT EXISTS schwab_account_summary (
  id                  TEXT PRIMARY KEY,
  account_number      TEXT NOT NULL UNIQUE, -- last 4 digits
  account_type        TEXT NOT NULL,
  account_label       TEXT NOT NULL,
  liquidation_value   REAL NOT NULL DEFAULT 0,
  cash_balance        REAL NOT NULL DEFAULT 0,
  day_pnl             REAL NOT NULL DEFAULT 0,
  synced_at           TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
