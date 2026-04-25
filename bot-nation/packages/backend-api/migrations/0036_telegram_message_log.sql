-- 0036: Telegram message log — persist every in/out message for quality improvement
-- Previously only console.log (lost immediately). Now stored in D1.

CREATE TABLE IF NOT EXISTS telegram_messages (
  id           TEXT PRIMARY KEY,
  direction    TEXT NOT NULL,   -- 'in' | 'out'
  chat_id      TEXT NOT NULL,
  user_id      TEXT,            -- Telegram user ID (for 'in' messages)
  text         TEXT NOT NULL,
  task_id      TEXT,            -- associated task (if any)
  route_type   TEXT,            -- 'action' | 'command' | 'intel_url' | 'supervisor' | 'learn'
  agent_id     TEXT,            -- which agent handled/sent this
  quality      INTEGER,         -- 1-5 operator rating (nullable until rated)
  quality_note TEXT,            -- optional rating note
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tg_msg_chat    ON telegram_messages(chat_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_msg_route   ON telegram_messages(route_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_msg_quality ON telegram_messages(quality, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tg_msg_task    ON telegram_messages(task_id);
