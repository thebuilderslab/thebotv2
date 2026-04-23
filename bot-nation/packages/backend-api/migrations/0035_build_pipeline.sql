-- 0035: Self-modification pipeline
-- Stores pending code changes so GitHub Actions can fetch them.
-- Also registers the two new build tools for agent-build-lead.

CREATE TABLE IF NOT EXISTS code_changes (
  id             TEXT PRIMARY KEY,
  task_id        TEXT,
  agent_id       TEXT NOT NULL,
  files          TEXT NOT NULL,          -- JSON: [{path, content}]
  commit_message TEXT NOT NULL,
  status         TEXT DEFAULT 'pending', -- pending | dispatched | deployed | failed
  chat_id        TEXT,                   -- Telegram chat to notify
  run_url        TEXT,                   -- GitHub Actions run URL (filled on complete)
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_code_changes_task  ON code_changes(task_id);
CREATE INDEX IF NOT EXISTS idx_code_changes_agent ON code_changes(agent_id, created_at DESC);

-- Tool: submit_code_change — agent-build-lead calls this to deploy a code change
INSERT OR IGNORE INTO tools (id, name, kind, description, schema, endpoint, status, created_at, updated_at)
VALUES (
  'tool-submit-code-change',
  'submit_code_change',
  'http_api',
  'Submit a code change for operator review + deployment. The operator will see a preview with your change_summary and the first 600 chars of the file, then tap ✅ Deploy or ❌ Cancel. IMPORTANT: (1) always call read_github_file first to get current content, (2) provide the COMPLETE file content (not a diff), (3) write a clear change_summary explaining exactly what you changed and why.',
  '{"type":"object","properties":{"files":{"type":"array","description":"Array of files to write","items":{"type":"object","properties":{"path":{"type":"string","description":"Repo-relative path e.g. packages/backend-api/src/routes/finance.ts"},"content":{"type":"string","description":"Full new file content (not a diff — complete file)"}},"required":["path","content"]}},"commit_message":{"type":"string","description":"Concise git commit message (imperative tense, under 72 chars)"},"change_summary":{"type":"string","description":"Plain-English description of what you changed and why — shown to operator in the preview. Be specific: name the function/variable/section you changed and describe the before/after."}},"required":["files","commit_message","change_summary"]}',
  'https://bot-nation-api.thejamalshackleford.workers.dev/api/build/submit',
  'active',
  datetime('now'),
  datetime('now')
);

-- Tool: read_github_file — read current file content from repo before modifying
INSERT OR IGNORE INTO tools (id, name, kind, description, schema, endpoint, status, created_at, updated_at)
VALUES (
  'tool-read-github-file',
  'read_github_file',
  'http_api',
  'Read the current content of a file from the bot-nation GitHub repo. Call this BEFORE using submit_code_change so you have the exact current content to work from. Returns the file content as a string.',
  '{"type":"object","properties":{"path":{"type":"string","description":"Repo-relative file path e.g. packages/backend-api/src/routes/finance.ts"}},"required":["path"]}',
  'https://bot-nation-api.thejamalshackleford.workers.dev/api/build/read-file',
  'active',
  datetime('now'),
  datetime('now')
);
