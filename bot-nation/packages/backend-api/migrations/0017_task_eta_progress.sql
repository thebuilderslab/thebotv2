-- Phase 9B: ETA + Telegram progress tracking
-- Adds columns to tasks for live countdown/progress editing

ALTER TABLE tasks ADD COLUMN started_at TEXT;
ALTER TABLE tasks ADD COLUMN telegram_chat_id INTEGER;
ALTER TABLE tasks ADD COLUMN telegram_message_id INTEGER;
