-- Phase 5: Sub-task spawning + Tool use
-- Adds parent_task_id to tasks, seeds example tools

-- ─── tasks: parent relationship ───────────────────────────────────────────────
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);

-- Status values now include: pending, running, waiting_children, completed, failed

-- ─── seed tools ───────────────────────────────────────────────────────────────

-- Echo tool: zero-dependency HTTP test (httpbin.org echoes any POST body)
INSERT OR IGNORE INTO tools (id, name, kind, status, description, endpoint, schema, installed_by_agent_id, approval_id, created_at, updated_at)
VALUES (
  'tool-echo-001',
  'echo',
  'http_api',
  'active',
  'Echoes back any JSON payload. Use for testing tool call flow.',
  'https://httpbin.org/post',
  '{"type":"object","properties":{"message":{"type":"string","description":"Text to echo back"}},"required":["message"]}',
  NULL, NULL, datetime('now'), datetime('now')
);

-- Web search tool (Brave Search API — requires BRAVE_SEARCH_API_KEY secret)
INSERT OR IGNORE INTO tools (id, name, kind, status, description, endpoint, schema, installed_by_agent_id, approval_id, created_at, updated_at)
VALUES (
  'tool-web-search-001',
  'web_search',
  'web_search',
  'active',
  'Performs a web search via Brave Search API and returns top results.',
  'https://api.search.brave.com/res/v1/web/search',
  '{"type":"object","properties":{"query":{"type":"string","description":"Search query"},"count":{"type":"integer","description":"Number of results (max 10)","default":5}},"required":["query"]}',
  NULL, NULL, datetime('now'), datetime('now')
);

-- Self-ping tool: calls the Bot Nation health endpoint — always works, no secrets needed
INSERT OR IGNORE INTO tools (id, name, kind, status, description, endpoint, schema, installed_by_agent_id, approval_id, created_at, updated_at)
VALUES (
  'tool-self-ping-001',
  'self_ping',
  'http_api',
  'active',
  'Pings the Bot Nation API health endpoint. Zero-dependency test.',
  'https://bot-nation-api.thejamalshackleford.workers.dev/health',
  '{"type":"object","properties":{},"required":[]}',
  NULL, NULL, datetime('now'), datetime('now')
);
