-- Task Scheduler Implementation
-- Add scheduled_for column to support delayed task execution

ALTER TABLE tasks ADD COLUMN scheduled_for TEXT;

-- Index for dispatcher optimization
-- Filters: WHERE status='pending' AND assigned_agent_id IS NOT NULL AND (scheduled_for IS NULL OR scheduled_for <= now)
CREATE INDEX idx_tasks_scheduled_status ON tasks(scheduled_for, status);
