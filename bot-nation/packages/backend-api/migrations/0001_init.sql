CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  domain TEXT NOT NULL,
  team_id TEXT,
  traits TEXT NOT NULL DEFAULT "[]",
  capabilities TEXT NOT NULL DEFAULT "[]",
  active INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  lead_agent_id TEXT,
  member_ids TEXT NOT NULL DEFAULT "[]",
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
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
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  requested_by_agent_id TEXT,
  brief TEXT NOT NULL DEFAULT "{}",
  status TEXT NOT NULL DEFAULT "pending",
  decisions TEXT NOT NULL DEFAULT "[]",
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  task_id TEXT,
  related_agent_ids TEXT NOT NULL DEFAULT "[]",
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id);