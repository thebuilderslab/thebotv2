-- =============================================================================
-- Migration 0027: Proposal system columns + scheduled_crons + introspection view
-- =============================================================================

-- ── Extend proposals table ────────────────────────────────────────────────────
-- The telegram /propose command uses these columns; they were missing from 0002.
ALTER TABLE proposals ADD COLUMN description TEXT;
ALTER TABLE proposals ADD COLUMN agent_id TEXT;
ALTER TABLE proposals ADD COLUMN team_id TEXT;
ALTER TABLE proposals ADD COLUMN cron_expression TEXT;   -- cron_request proposals: e.g. "0 9 * * *"
ALTER TABLE proposals ADD COLUMN task_kind TEXT;         -- cron_request proposals: task kind to run
ALTER TABLE proposals ADD COLUMN approved_at TEXT;       -- ISO timestamp when approved
ALTER TABLE proposals ADD COLUMN approved_by TEXT;       -- telegram user id or "system"

-- ── scheduled_crons — approved cron jobs waiting to be activated / active ─────
CREATE TABLE IF NOT EXISTS scheduled_crons (
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

CREATE INDEX IF NOT EXISTS idx_scheduled_crons_status ON scheduled_crons(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_crons_proposal ON scheduled_crons(proposal_id);

-- ── agent_introspection view — safe read-only snapshot agents can query ───────
-- Agents call the query_db tool with view name "agent_introspection" to see
-- their own recent tasks, notes, and costs without hallucinating system state.
CREATE VIEW IF NOT EXISTS agent_introspection AS
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

-- ── system_health view — supervisor reminder snapshot ─────────────────────────
CREATE VIEW IF NOT EXISTS system_health AS
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
