-- 0043: MEM-1 — bridge persistTelegramMessage writers to chat_messages
--
-- Phase B's first memory-layer fix. Before MEM-1, Telegram messages persisted
-- via `persistTelegramMessage` (in nation-supervisor.ts) only landed in the
-- `telegram_messages` table; the `chat_messages` table (the unified memory
-- surface read by agents via `getRecentHistory`) was only populated by direct
-- `storeMessage` calls inside the supervisor handler. As a result, action
-- queries (which bypass the supervisor entirely) and any other paths that
-- went through `persistTelegramMessage` left the unified memory surface
-- blind to the conversation.
--
-- This migration adds a single nullable column + a partial UNIQUE index so
-- the new persistTelegramMessage→storeMessage path is idempotent: repeated
-- calls with the same Telegram message ID produce exactly one chat_messages
-- row. Existing rows (and rows from supervisor's direct storeMessage calls,
-- which don't carry a Telegram message ID) have telegram_message_id=NULL
-- and are unaffected by the partial UNIQUE.

ALTER TABLE chat_messages ADD COLUMN telegram_message_id INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_telegram_id
  ON chat_messages(chat_id, telegram_message_id)
  WHERE telegram_message_id IS NOT NULL;
