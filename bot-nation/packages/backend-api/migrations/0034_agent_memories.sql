-- 0034: Agent memory layer (MemPalace-style persistent memory)
-- Stores distilled memories per agent — summaries of past tasks, learned facts,
-- and operator-noted preferences. Injected into system prompt at task start.

CREATE TABLE IF NOT EXISTS agent_memories (
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

CREATE INDEX IF NOT EXISTS idx_agent_memories_agent
  ON agent_memories(agent_id, importance DESC, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_memories_task
  ON agent_memories(task_id);
