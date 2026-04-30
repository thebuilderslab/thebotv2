-- Chat memory: stores recent conversation messages per chat for context
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',  -- 'user' or 'assistant'
  content TEXT NOT NULL,
  query_type TEXT,                     -- 'simple', 'infrastructure', 'action'
  task_id TEXT,                        -- if a task was created
  pending_action TEXT,                 -- stores proposed action for yes/no follow-ups
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_id ON chat_messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at);
