-- 0040: Universal Compare-And-Swap (CAS) state-machine discipline
--
-- Closes section 1 #1, #3, #4, #5, #6 of the bot-nation CAS rollout doc.
-- (#2 pending_orders + the scheduled_crons portion of #5 deferred until those
--  upstream migrations land in tracked main; the cron lock is implemented via a
--  dedicated cron_locks table here so it works regardless.)
-- (#7 code_changes was already CAS-guarded — Worker b6ae5c65.)
-- (#8 update-id dedup — already idempotent via INSERT OR IGNORE.)
--
-- The pattern is the same primitive every time:
--   UPDATE <table> SET status='<claimed>', claimed_by=?, updated_at=?
--   WHERE id=? AND status='<expected_prior>'
-- Then assert meta.changes === 1. claimed_by gives the audit trail.

-- ── 1. claimed_by columns on existing state-machine tables ───────────────────
-- SQLite doesn't support `ADD COLUMN IF NOT EXISTS`, so re-applying this
-- migration after column add is a no-op: D1 errors are caught by the runner
-- and the column add is naturally idempotent because `migrations_meta` records
-- which migration files have run.

ALTER TABLE tasks     ADD COLUMN claimed_by TEXT;
ALTER TABLE approvals ADD COLUMN claimed_by TEXT;
ALTER TABLE proposals ADD COLUMN claimed_by TEXT;

-- ── 2. Cron locks — closes section 1 #5 + section 3 cron use cases ──────────
-- Every cron handler claims a row here at tick start. Overlapping ticks find
-- the row in 'running' state and no-op. expires_at lets stuck ticks be reaped
-- by a later tick rather than being permanently locked.
CREATE TABLE IF NOT EXISTS cron_locks (
  cron_key    TEXT PRIMARY KEY,         -- stable id per cron, e.g. "supervisor_digest"
  status      TEXT NOT NULL,            -- 'running' | 'idle'
  claimed_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,            -- claimed_at + max-runtime budget
  last_run_at TEXT,
  run_count   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
);

-- ── 3. Outbound Telegram dedup — closes section 1 #6 ────────────────────────
-- Supervisor + auto-answer + reminders can each independently send the same
-- alert. Hash (chat_id, route_type, hour_bucket, content_hash) and
-- INSERT OR IGNORE before send. Duplicate rows = duplicate sends = silenced.
CREATE TABLE IF NOT EXISTS telegram_outbound_dedup (
  dedup_key   TEXT PRIMARY KEY,         -- "<chat_id>:<route_type>:<hour_bucket>:<sha1(content)>"
  chat_id     TEXT NOT NULL,
  route_type  TEXT NOT NULL,
  hour_bucket TEXT NOT NULL,            -- ISO hour, e.g. "2026-04-26T22"
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_outbound_dedup_chat ON telegram_outbound_dedup(chat_id, created_at DESC);
