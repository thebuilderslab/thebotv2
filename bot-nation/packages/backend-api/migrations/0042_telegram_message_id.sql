-- 0042: add Telegram message_id to telegram_messages for reply threading
-- Existing schema (0036) only stored a UUID PK. The Telegram int message_id
-- is needed to (a) log inbound message ids for replying-to and (b) link
-- our outbound bot messages back to a specific Telegram thread.

ALTER TABLE telegram_messages ADD COLUMN message_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_tg_msg_id ON telegram_messages(message_id);
