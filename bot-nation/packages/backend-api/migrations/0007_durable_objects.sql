-- Phase 6: Durable Objects — agent sessions and execution graphs

-- ─── tasks: session reference ─────────────────────────────────────────────────
ALTER TABLE tasks ADD COLUMN session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);

-- ─── agent_sessions ───────────────────────────────────────────────────────────
-- Tracks active Durable Object sessions per agent
CREATE TABLE IF NOT EXISTS agent_sessions (
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
CREATE INDEX IF NOT EXISTS idx_sessions_agent  ON agent_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON agent_sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_task   ON agent_sessions(task_id);

-- ─── agent_graphs ─────────────────────────────────────────────────────────────
-- LangGraph-style execution graphs stored as JSON
CREATE TABLE IF NOT EXISTS agent_graphs (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  definition  TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[],"startNode":""}',
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graphs_agent ON agent_graphs(agent_id);

-- Seed a default research graph for agent-research-lead
INSERT OR IGNORE INTO agent_graphs (id, agent_id, name, description, definition, is_default, created_at, updated_at)
VALUES (
  'graph-research-default',
  'agent-research-lead',
  'Deep Research Graph',
  'Multi-step research: web search → analysis → structured report',
  '{
    "nodes": [
      {"id":"search","kind":"tool_call","toolName":"web_search","label":"Search Web"},
      {"id":"analyze","kind":"llm_call","prompt":"Analyze the search results and identify key themes: {{prev}}","label":"Analyze Results"},
      {"id":"report","kind":"llm_call","prompt":"Write a structured research report based on the analysis: {{prev}}","label":"Write Report"},
      {"id":"end","kind":"end","label":"Done"}
    ],
    "edges": [
      {"from":"search","to":"analyze","condition":"always"},
      {"from":"analyze","to":"report","condition":"always"},
      {"from":"report","to":"end","condition":"always"}
    ],
    "startNode":"search"
  }',
  1,
  datetime('now'),
  datetime('now')
);
