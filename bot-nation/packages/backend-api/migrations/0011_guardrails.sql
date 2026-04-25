-- Phase 7C: Safety guardrails schema additions

-- Add spawn_depth to tasks so we can enforce a max recursion limit.
-- depth 0 = root task, depth 1 = first-level child, depth 2 = grandchild, etc.
ALTER TABLE tasks ADD COLUMN spawn_depth INTEGER NOT NULL DEFAULT 0;

-- Index for quickly finding tasks at a given depth (useful for auditing runaway trees)
CREATE INDEX IF NOT EXISTS idx_tasks_spawn_depth ON tasks(spawn_depth);
