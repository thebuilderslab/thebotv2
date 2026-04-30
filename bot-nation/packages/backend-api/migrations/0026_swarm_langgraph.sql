-- =============================================================================
-- Migration 0026: OpenAI Swarm handoff protocol + LangGraph state snapshots
-- =============================================================================
-- Swarm pattern: agents explicitly transfer control to a named peer agent by
--   returning <HANDOFF to="agent-id">context</HANDOFF> — no implicit spawn_depth
--   tree needed. The handoff chain is fully traceable via handoff_from / handoff_to.
--
-- LangGraph pattern: each graph traversal node snapshots its full state so
--   retries resume exactly where they left off, and cycle detection can inspect
--   the visited-node history.
-- =============================================================================

-- ── Swarm handoff columns ─────────────────────────────────────────────────────
ALTER TABLE tasks ADD COLUMN handoff_to TEXT;
-- target agent ID — set when this task hands off to a peer
ALTER TABLE tasks ADD COLUMN handoff_from TEXT;
-- source agent ID — set on the new task created by the handoff
ALTER TABLE tasks ADD COLUMN handoff_context TEXT;
-- context blob passed at handoff time (task summary for the receiver)

-- ── LangGraph state snapshot ──────────────────────────────────────────────────
ALTER TABLE tasks ADD COLUMN state_snapshot TEXT;
-- JSON: { currentNodeId, prevOutput, visitedNodes: string[], nodeHistory: [{id, output, ts}] }
-- Written after each graph node; used for precise checkpoint resume + cycle detection

-- ── Index for handoff chain lookup ───────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tasks_handoff_from ON tasks(handoff_from);
CREATE INDEX IF NOT EXISTS idx_tasks_handoff_to   ON tasks(handoff_to);

-- ── Swarm handoff_log view (read-only audit trail) ───────────────────────────
-- Shows the full chain: which agent handed off to which, with what context
CREATE VIEW IF NOT EXISTS swarm_handoff_chain AS
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
