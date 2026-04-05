-- Migration 0004: Knowledge & Memory layer
-- Adds: agent_notes table, content column on artifacts

-- ─── agent scratchpad notes ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_notes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(agent_id, key)
);

CREATE INDEX IF NOT EXISTS idx_notes_agent ON agent_notes(agent_id);

-- ─── artifacts: add inline content storage ───────────────────────────────────
-- url is now optional (content may be stored inline instead)
ALTER TABLE artifacts ADD COLUMN content TEXT;

-- ─── indexes for artifact queries ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts(kind);
