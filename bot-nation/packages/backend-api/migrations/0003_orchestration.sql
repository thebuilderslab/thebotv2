-- Migration 0003: Orchestration layer
-- Adds: team_id to tasks, Nation Supervisor seed, routing indexes

-- ─── tasks: add team routing column ─────────────────────────────────────────
ALTER TABLE tasks ADD COLUMN team_id TEXT;

-- ─── indexes for cron dispatcher queries ────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tasks_assigned   ON tasks(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_team       ON tasks(team_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status_assigned ON tasks(status, assigned_agent_id);

-- ─── seed Nation Supervisor agent ───────────────────────────────────────────
INSERT OR IGNORE INTO agents (
  id, name, role, domain, team_id, status, permissions,
  traits, capabilities, description, created_at, updated_at
) VALUES (
  'agent-supervisor-001',
  'Nation Supervisor',
  'governor',
  'governance',
  NULL,
  'active',
  '{"canWriteCode":false,"canModifyAgents":true,"canTouchWallets":false,"canAutoDeploy":false}',
  '[]',
  '[]',
  'Top-level orchestrator. Interprets human goals, creates tasks, delegates to teams.',
  datetime('now'),
  datetime('now')
);
