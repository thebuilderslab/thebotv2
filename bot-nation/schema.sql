-- =============================================================================
-- bot-nation-api — consolidated D1 schema (CURRENT-STATE SNAPSHOT)
-- =============================================================================
-- GENERATED from migrations 0001_init.sql .. 0045_projecT87_tools.sql (0019 does not exist).
-- This is the net effect of all migrations applied in order — the authoritative
-- current shape of the `pbot-nation-db` D1 database. Migrations remain the source
-- of truth for D1; this file is a readable snapshot (do not hand-edit).
--
-- Objects: 39 tables, 72 secondary indexes, 3 views, 3 triggers.
-- SQLite/D1: all `id` primary keys are TEXT; timestamps are TEXT (ISO-8601 strings).
--
-- -- BOTTLENECKS (verified from this snapshot; noted, NOT changed) -------------
-- FOREIGN KEYS: only 2 declared —
--   agency_deploys.site_id -> agency_sites.id
--   skill_refinements.skill_id -> skills.id
--   Every other cross-table relationship (tasks<->agents/teams/approvals,
--   proposals<->approvals, events.target_id, tws_*<->tasks, etc.) is a SOFT
--   reference with no FK constraint — referential integrity is app-enforced.
-- NO SECONDARY INDEX (only the PK/UNIQUE autoindex) — full scans when filtered:
--   agency_deploys, agency_sites, agent_memories_fts, agents, cron_locks, schwab_account_summary, teams, tws_backtests, tws_order_suggestions, tws_ws_sessions
--   e.g. agents/teams have no index on team_id/status/domain.
-- FTS: agent_memories_fts is an fts5 virtual table kept in sync by the 3 triggers
--   below; its shadow tables (_data/_idx/_docsize/_config) are auto-managed.
-- ---------------------------------------------------------------------------


-- ===== TABLES =====

CREATE TABLE agency_deploys (
  id           TEXT PRIMARY KEY,
  site_id      TEXT NOT NULL REFERENCES agency_sites(id),
  triggered_by TEXT,
  cf_deploy_id TEXT,
  branch       TEXT DEFAULT 'main',
  status       TEXT DEFAULT 'pending',   -- pending | building | success | failed
  error        TEXT,
  deployed_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE agency_sites (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  repo_path     TEXT,
  pages_project TEXT,
  domain        TEXT,
  tech_stack    TEXT DEFAULT 'react-vite',
  status        TEXT DEFAULT 'imported',  -- imported | deployed | live
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE agent_graphs (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  definition  TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[],"startNode":""}',
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE agent_memories (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  summary     TEXT NOT NULL,       -- 1-3 sentence distilled memory
  source_kind TEXT DEFAULT 'task', -- 'task' | 'operator_note' | 'self_learn'
  task_id     TEXT,                -- source task id (nullable)
  importance  INTEGER DEFAULT 2,   -- 1=low 2=medium 3=high
  tags        TEXT DEFAULT '[]',   -- JSON array e.g. ["finance","GOOGL","options"]
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE VIRTUAL TABLE agent_memories_fts
  USING fts5(
    summary,
    tags,
    content=agent_memories,
    content_rowid=rowid
  );

CREATE TABLE agent_notes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(agent_id, key)
);

CREATE TABLE agent_sessions (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  task_id      TEXT,
  graph_id     TEXT,
  status       TEXT NOT NULL DEFAULT 'idle',  -- idle | running | streaming | completed | failed
  ws_connected INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  domain TEXT NOT NULL,
  team_id TEXT,
  traits TEXT NOT NULL DEFAULT "[]",
  capabilities TEXT NOT NULL DEFAULT "[]",
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, status TEXT NOT NULL DEFAULT 'active', permissions TEXT NOT NULL DEFAULT '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}', objectives TEXT);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  requested_by_agent_id TEXT,
  brief TEXT NOT NULL DEFAULT "{}",
  status TEXT NOT NULL DEFAULT "pending",
  decisions TEXT NOT NULL DEFAULT "[]",
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, claimed_by TEXT);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  task_id TEXT,
  related_agent_ids TEXT NOT NULL DEFAULT "[]",
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, content TEXT);

CREATE TABLE chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',  -- 'user' or 'assistant'
  content TEXT NOT NULL,
  query_type TEXT,                     -- 'simple', 'infrastructure', 'action'
  task_id TEXT,                        -- if a task was created
  pending_action TEXT,                 -- stores proposed action for yes/no follow-ups
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE code_changes (
  id             TEXT PRIMARY KEY,
  task_id        TEXT,
  agent_id       TEXT NOT NULL,
  files          TEXT NOT NULL,          -- JSON: [{path, content}]
  commit_message TEXT NOT NULL,
  status         TEXT DEFAULT 'pending', -- pending | dispatched | deployed | failed
  chat_id        TEXT,                   -- Telegram chat to notify
  run_url        TEXT,                   -- GitHub Actions run URL (filled on complete)
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE cron_locks (
  cron_key    TEXT PRIMARY KEY,         -- stable id per cron, e.g. "supervisor_digest"
  status      TEXT NOT NULL,            -- 'running' | 'idle'
  claimed_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,            -- claimed_at + max-runtime budget
  last_run_at TEXT,
  run_count   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- EventKind enum value
  actor_id TEXT,                      -- agent or human ID; null for system events
  target_kind TEXT NOT NULL,          -- "agent"|"team"|"proposal"|"approval"|"task"|"tool"
  target_id TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}', -- before/after snapshot, error info, etc.
  session_id TEXT,                    -- groups events from one workflow run
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE missed_actions (
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

CREATE TABLE pending_orders (
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

CREATE TABLE position_snapshots (
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
, gamma REAL, implied_volatility REAL, enrichment_method TEXT, enrichment_failed INTEGER NOT NULL DEFAULT 0);

CREATE TABLE price_targets (
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

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,

  -- Type and target
  type TEXT NOT NULL,                  -- ProposalType enum value
  target_entity_kind TEXT NOT NULL,   -- "agent" | "team" | "policy" | "tool"
  target_entity_id TEXT NOT NULL,

  -- Requester (at most one of these will be non-null per request)
  requester_agent_id TEXT,
  requester_team_id TEXT,
  requester_human_id TEXT,

  -- Human-readable brief
  title TEXT NOT NULL,
  summary TEXT NOT NULL,

  -- The partial patch to apply to the target entity on approval
  change_set TEXT NOT NULL DEFAULT '{}',

  -- Risk assessment
  risk_level TEXT NOT NULL DEFAULT 'low',
  risk_affects_wallets INTEGER NOT NULL DEFAULT 0,    -- 0=false, 1=true
  risk_affects_deployment INTEGER NOT NULL DEFAULT 0,
  risk_notes TEXT,

  -- Evaluation (set by inspector/reviewer agent after proposal is submitted)
  eval_passed INTEGER,                -- NULL=not evaluated, 0=failed, 1=passed
  eval_benchmarks TEXT NOT NULL DEFAULT '[]',
  eval_evaluated_at TEXT,

  -- Links
  approval_id TEXT,                   -- FK → approvals.id (set when pending_approval)

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'draft',
  applied_at TEXT,                    -- set when status = 'applied'

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, description TEXT, agent_id TEXT, team_id TEXT, cron_expression TEXT, task_kind TEXT, approved_at TEXT, approved_by TEXT, claimed_by TEXT);

CREATE TABLE scheduled_crons (
  id              TEXT PRIMARY KEY,
  proposal_id     TEXT NOT NULL,          -- links back to proposals.id
  cron_job_id     TEXT NOT NULL DEFAULT '',  -- Cloudflare cron job id (if applicable)
  cron_expression TEXT,                   -- copy of proposals.cron_expression
  task_kind       TEXT,                   -- copy of proposals.task_kind
  agent_id        TEXT,                   -- agent to run the task
  team_id         TEXT,
  status          TEXT NOT NULL DEFAULT 'pending_creation',
                                          -- pending_creation | active | paused | deleted
  last_run_at     TEXT,
  next_run_at     TEXT,
  run_count       INTEGER DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE schwab_account_summary (
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

CREATE TABLE schwab_positions (
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

CREATE TABLE skill_refinements (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  refinement_type TEXT,
  change_summary TEXT,
  before_procedure TEXT,
  after_procedure TEXT,
  quality_delta REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (skill_id) REFERENCES skills(id)
);

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  trigger_pattern TEXT,
  procedure TEXT,
  created_from_task_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT,
  use_count INTEGER DEFAULT 0,
  quality_score REAL DEFAULT 0.7,
  version INTEGER DEFAULT 1
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT "pending",
  created_by_agent_id TEXT,
  assigned_agent_id TEXT,
  input TEXT NOT NULL DEFAULT "{}",
  output TEXT,
  approval_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, team_id TEXT, parent_task_id TEXT, session_id TEXT, spawn_depth INTEGER NOT NULL DEFAULT 0, started_at TEXT, telegram_chat_id INTEGER, telegram_message_id INTEGER, retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3, last_graph_node_id TEXT, scheduled_for TEXT, handoff_to TEXT, handoff_from TEXT, handoff_context TEXT, state_snapshot TEXT, claimed_by TEXT);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  lead_agent_id TEXT,
  member_ids TEXT NOT NULL DEFAULT "[]",
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, parent_team_id TEXT, policies TEXT NOT NULL DEFAULT '{"maxRiskTier":"low","requiresHumanApproval":true,"allowedCapabilities":[],"blockedCapabilities":[]}', objectives TEXT);

CREATE TABLE telegram_messages (
  id           TEXT PRIMARY KEY,
  direction    TEXT NOT NULL,   -- 'in' | 'out'
  chat_id      TEXT NOT NULL,
  user_id      TEXT,            -- Telegram user ID (for 'in' messages)
  text         TEXT NOT NULL,
  task_id      TEXT,            -- associated task (if any)
  route_type   TEXT,            -- 'action' | 'command' | 'intel_url' | 'supervisor' | 'learn'
  agent_id     TEXT,            -- which agent handled/sent this
  quality      INTEGER,         -- 1-5 operator rating (nullable until rated)
  quality_note TEXT,            -- optional rating note
  created_at   TEXT NOT NULL
, message_id INTEGER);

CREATE TABLE telegram_outbound_dedup (
  dedup_key   TEXT PRIMARY KEY,         -- "<chat_id>:<route_type>:<hour_bucket>:<sha1(content)>"
  chat_id     TEXT NOT NULL,
  route_type  TEXT NOT NULL,
  hour_bucket TEXT NOT NULL,            -- ISO hour, e.g. "2026-04-26T22"
  created_at  TEXT NOT NULL
);

CREATE TABLE tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- "mcp"|"api"|"script"|"browser"|"internal"
  status TEXT NOT NULL DEFAULT 'pending_review',
  description TEXT,
  endpoint TEXT,
  schema TEXT,                        -- MCP-style JSON Schema (nullable)
  installed_by_agent_id TEXT,
  approval_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE trade_decision_quality_metrics (
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

CREATE TABLE tws_alerts (
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

CREATE TABLE tws_backtests (
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

CREATE TABLE tws_order_suggestions (
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

CREATE TABLE tws_positions (
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

CREATE TABLE tws_signals (
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

CREATE TABLE tws_watchlist (
  id         TEXT PRIMARY KEY,
  symbol     TEXT NOT NULL UNIQUE,
  asset_type TEXT NOT NULL DEFAULT 'equity',  -- equity | option | etf
  notes      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE tws_ws_sessions (
  id           TEXT PRIMARY KEY,
  client_label TEXT,                   -- e.g. "thinkorswim-desktop"
  status       TEXT DEFAULT 'active',  -- active | disconnected
  last_ping    TEXT,
  symbols      TEXT,                   -- JSON array of subscribed symbols
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE watchlist_snapshots (
  id           TEXT PRIMARY KEY,
  symbol       TEXT NOT NULL,
  close_price  REAL NOT NULL,
  volume       INTEGER,
  recorded_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE youtube_market_summaries (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  video_id         TEXT NOT NULL,
  video_title      TEXT,
  video_url        TEXT,
  playlist_url     TEXT,
  published_at     TEXT,
  analyzed_at      TEXT NOT NULL,
  tldr             TEXT,
  sentiment        TEXT CHECK(sentiment IN ('bullish','bearish','neutral','mixed')),
  key_tickers      TEXT,           -- JSON array of ticker strings
  highlights       TEXT NOT NULL,  -- JSON array of MarketHighlight objects
  transcript_chars INTEGER,        -- length of raw transcript used
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);


-- ===== INDEXES =====

CREATE INDEX idx_agent_memories_agent
  ON agent_memories(agent_id, importance DESC, created_at DESC);
CREATE INDEX idx_agent_memories_task
  ON agent_memories(task_id);
CREATE INDEX idx_approvals_status ON approvals(status);
CREATE INDEX idx_approvals_task ON approvals(task_id);
CREATE INDEX idx_artifacts_kind ON artifacts(kind);
CREATE INDEX idx_artifacts_task ON artifacts(task_id);
CREATE INDEX idx_chat_messages_chat_id ON chat_messages(chat_id);
CREATE INDEX idx_chat_messages_created_at ON chat_messages(created_at);
CREATE INDEX idx_code_changes_agent ON code_changes(agent_id, created_at DESC);
CREATE INDEX idx_code_changes_task  ON code_changes(task_id);
CREATE INDEX idx_events_created_at ON events(created_at);
CREATE INDEX idx_events_kind       ON events(kind);
CREATE INDEX idx_events_session    ON events(session_id);
CREATE INDEX idx_events_target     ON events(target_kind, target_id);
CREATE INDEX idx_graphs_agent ON agent_graphs(agent_id);
CREATE UNIQUE INDEX idx_metrics_date_agent_metric
  ON trade_decision_quality_metrics(date, agent_id, metric_name);
CREATE INDEX idx_missed_actions_detected
  ON missed_actions(detected_at DESC);
CREATE INDEX idx_missed_actions_symbol
  ON missed_actions(symbol, detected_at DESC);
CREATE INDEX idx_notes_agent ON agent_notes(agent_id);
CREATE INDEX idx_outbound_dedup_chat ON telegram_outbound_dedup(chat_id, created_at DESC);
CREATE INDEX idx_pending_orders_expires ON pending_orders(expires_at);
CREATE INDEX idx_pending_orders_status ON pending_orders(status);
CREATE INDEX idx_position_snapshots_agent
  ON position_snapshots(agent_id, created_at DESC);
CREATE INDEX idx_position_snapshots_symbol
  ON position_snapshots(symbol, created_at DESC);
CREATE INDEX idx_price_targets_generated ON price_targets(generated_at DESC);
CREATE INDEX idx_price_targets_symbol ON price_targets(symbol);
CREATE INDEX idx_proposals_approval      ON proposals(approval_id);
CREATE INDEX idx_proposals_requester_agent ON proposals(requester_agent_id);
CREATE INDEX idx_proposals_status        ON proposals(status);
CREATE INDEX idx_proposals_target        ON proposals(target_entity_kind, target_entity_id);
CREATE INDEX idx_scheduled_crons_proposal ON scheduled_crons(proposal_id);
CREATE INDEX idx_scheduled_crons_status ON scheduled_crons(status);
CREATE INDEX idx_schwab_positions_account ON schwab_positions(account_number);
CREATE INDEX idx_schwab_positions_symbol  ON schwab_positions(symbol);
CREATE INDEX idx_sessions_agent  ON agent_sessions(agent_id);
CREATE INDEX idx_sessions_status ON agent_sessions(status);
CREATE INDEX idx_sessions_task   ON agent_sessions(task_id);
CREATE INDEX idx_skill_refinements_skill ON skill_refinements(skill_id);
CREATE INDEX idx_skills_name ON skills(name);
CREATE INDEX idx_skills_quality ON skills(quality_score DESC);
CREATE INDEX idx_skills_trigger ON skills(trigger_pattern);
CREATE INDEX idx_tasks_assigned   ON tasks(assigned_agent_id);
CREATE INDEX idx_tasks_handoff_from ON tasks(handoff_from);
CREATE INDEX idx_tasks_handoff_to   ON tasks(handoff_to);
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX idx_tasks_scheduled_status ON tasks(scheduled_for, status);
CREATE INDEX idx_tasks_session ON tasks(session_id);
CREATE INDEX idx_tasks_spawn_depth ON tasks(spawn_depth);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_status_assigned ON tasks(status, assigned_agent_id);
CREATE INDEX idx_tasks_team       ON tasks(team_id);
CREATE INDEX idx_tg_msg_chat    ON telegram_messages(chat_id, created_at DESC);
CREATE INDEX idx_tg_msg_id ON telegram_messages(message_id);
CREATE INDEX idx_tg_msg_quality ON telegram_messages(quality, created_at DESC);
CREATE INDEX idx_tg_msg_route   ON telegram_messages(route_type, created_at DESC);
CREATE INDEX idx_tg_msg_task    ON telegram_messages(task_id);
CREATE INDEX idx_tools_kind   ON tools(kind);
CREATE INDEX idx_tools_status ON tools(status);
CREATE INDEX idx_tws_alerts_symbol ON tws_alerts(symbol);
CREATE INDEX idx_tws_alerts_triggered ON tws_alerts(triggered_at DESC);
CREATE INDEX idx_tws_positions_expiry ON tws_positions(expiry);
CREATE INDEX idx_tws_positions_status ON tws_positions(status);
CREATE INDEX idx_tws_positions_symbol ON tws_positions(symbol);
CREATE INDEX idx_tws_signals_created ON tws_signals(created_at DESC);
CREATE INDEX idx_tws_signals_symbol ON tws_signals(symbol);
CREATE INDEX idx_tws_watchlist_active ON tws_watchlist(active);
CREATE INDEX idx_tws_watchlist_symbol ON tws_watchlist(symbol);
CREATE INDEX idx_watchlist_snapshots_symbol_date
  ON watchlist_snapshots(symbol, recorded_at DESC);
CREATE INDEX idx_yt_summaries_analyzed  ON youtube_market_summaries(analyzed_at DESC);
CREATE INDEX idx_yt_summaries_sentiment ON youtube_market_summaries(sentiment);
CREATE INDEX idx_yt_summaries_video     ON youtube_market_summaries(video_id);
CREATE UNIQUE INDEX uq_watchlist_snapshots_symbol_day
  ON watchlist_snapshots(symbol, date(recorded_at));


-- ===== VIEWS =====

CREATE VIEW agent_introspection AS
SELECT
  a.id            AS agent_id,
  a.name          AS agent_name,
  a.role,
  a.domain,
  t.id            AS task_id,
  t.kind          AS task_kind,
  t.status        AS task_status,
  t.created_at    AS task_created_at,
  t.updated_at    AS task_updated_at,
  t.retry_count,
  an.key          AS note_key,
  an.value        AS note_value,
  art.content     AS cost_content
FROM agents a
LEFT JOIN tasks t  ON t.assigned_agent_id = a.id
                   AND t.created_at > datetime('now', '-24 hours')
LEFT JOIN agent_notes an ON an.agent_id = a.id
LEFT JOIN artifacts art  ON art.task_id = t.id AND art.kind = 'cost'
ORDER BY t.created_at DESC;

CREATE VIEW swarm_handoff_chain AS
SELECT
  t.id          AS task_id,
  t.kind,
  t.status,
  t.handoff_from AS from_agent,
  t.assigned_agent_id AS to_agent,
  t.handoff_context,
  p.id          AS parent_task_id,
  p.assigned_agent_id AS original_agent,
  t.created_at
FROM tasks t
LEFT JOIN tasks p ON p.id = t.parent_task_id
WHERE t.handoff_from IS NOT NULL
ORDER BY t.created_at DESC;

CREATE VIEW system_health AS
SELECT
  (SELECT COUNT(*) FROM tasks WHERE status='pending')   AS pending_tasks,
  (SELECT COUNT(*) FROM tasks WHERE status='running')   AS running_tasks,
  (SELECT COUNT(*) FROM tasks WHERE status='completed'
    AND updated_at > datetime('now','-4 hours'))        AS completed_last_4h,
  (SELECT COUNT(*) FROM tasks WHERE status='failed'
    AND updated_at > datetime('now','-4 hours'))        AS failed_last_4h,
  (SELECT COUNT(*) FROM agents WHERE status='active')   AS active_agents,
  (SELECT COUNT(*) FROM proposals WHERE status='pending') AS pending_proposals,
  (SELECT COUNT(*) FROM scheduled_crons WHERE status='active') AS active_crons;


-- ===== TRIGGERS (agent_memories_fts sync) =====

CREATE TRIGGER agent_memories_ad
  AFTER DELETE ON agent_memories BEGIN
    INSERT INTO agent_memories_fts(agent_memories_fts, rowid, summary, tags)
    VALUES ('delete', old.rowid, old.summary, COALESCE(old.tags, '[]'));
  END;

CREATE TRIGGER agent_memories_ai
  AFTER INSERT ON agent_memories BEGIN
    INSERT INTO agent_memories_fts(rowid, summary, tags)
    VALUES (new.rowid, new.summary, COALESCE(new.tags, '[]'));
  END;

CREATE TRIGGER agent_memories_au
  AFTER UPDATE ON agent_memories BEGIN
    INSERT INTO agent_memories_fts(agent_memories_fts, rowid, summary, tags)
    VALUES ('delete', old.rowid, old.summary, COALESCE(old.tags, '[]'));
    INSERT INTO agent_memories_fts(rowid, summary, tags)
    VALUES (new.rowid, new.summary, COALESCE(new.tags, '[]'));
  END;

