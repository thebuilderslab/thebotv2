-- 0043: policy decision impact model schema
-- Tracks position snapshots, missed actions, and trade decision quality metrics
-- for Finance Lead's self-improvement feedback loop

CREATE TABLE IF NOT EXISTS position_snapshots (
  id                     TEXT PRIMARY KEY,
  agent_id               TEXT NOT NULL,
  timestamp              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  symbol                 TEXT NOT NULL,
  position_type          TEXT,
  quantity               INTEGER,
  entry_price            REAL,
  current_price          REAL,
  current_pnl_pct        REAL,
  days_to_expiry         INTEGER,
  delta                  REAL,
  theta                  REAL,
  vega                   REAL,
  underlying_price       REAL,
  policy_decision        TEXT,
  decision_rationale     TEXT,
  thresholds_at_snapshot TEXT,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_position_snapshots_agent
  ON position_snapshots(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_position_snapshots_symbol
  ON position_snapshots(symbol, created_at DESC);

CREATE TABLE IF NOT EXISTS missed_actions (
  id                  TEXT PRIMARY KEY,
  agent_id            TEXT,
  symbol              TEXT NOT NULL,
  missed_action_type  TEXT,
  entry_price         REAL,
  missed_at           TEXT,
  current_price       REAL,
  opportunity_cost    REAL,
  detected_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  manual_trade_taken  TEXT,
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_missed_actions_symbol
  ON missed_actions(symbol, detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_missed_actions_detected
  ON missed_actions(detected_at DESC);

CREATE TABLE IF NOT EXISTS trade_decision_quality_metrics (
  id                TEXT PRIMARY KEY,
  date              TEXT NOT NULL,
  agent_id          TEXT,
  metric_name       TEXT,
  value             REAL,
  target_threshold  REAL,
  status            TEXT,
  calculation_notes TEXT,
  recorded_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_metrics_date_agent_metric
  ON trade_decision_quality_metrics(date, agent_id, metric_name);
