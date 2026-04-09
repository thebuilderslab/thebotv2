-- Phase 1 Stability: Retry logic + Graph checkpointing
-- Adds columns for task retry attempts and graph node resume

ALTER TABLE tasks ADD COLUMN retry_count INTEGER DEFAULT 0;
ALTER TABLE tasks ADD COLUMN max_retries INTEGER DEFAULT 3;
ALTER TABLE tasks ADD COLUMN last_graph_node_id TEXT;  -- For checkpoint recovery
