-- Migration 0031: pending_orders table
-- Stores Schwab options orders staged by agent-finance-lead awaiting operator approval.
-- Flow: agent generates recommendation → stagePendingOrder() → user taps "Approve to execute" in Telegram
--        → executeOrder() submits to POST /trader/v1/accounts/{hashValue}/orders

CREATE TABLE IF NOT EXISTS pending_orders (
  id             TEXT PRIMARY KEY,
  account_number TEXT NOT NULL,    -- last 4 digits (e.g. "749")
  order_type     TEXT NOT NULL,    -- NET_CREDIT | NET_DEBIT | LIMIT
  price          REAL NOT NULL,    -- net limit price (positive = credit)
  legs           TEXT NOT NULL,    -- JSON array of OptionLeg objects
  description    TEXT NOT NULL,    -- human label e.g. "Roll 340C→355C for $0.87 credit"
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,    -- 30 min from created_at; reject if past
  status         TEXT NOT NULL DEFAULT 'pending_approval',  -- pending_approval | submitted | rejected | expired
  updated_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_orders_status ON pending_orders(status);
CREATE INDEX IF NOT EXISTS idx_pending_orders_expires ON pending_orders(expires_at);
