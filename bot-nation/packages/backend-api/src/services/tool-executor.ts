/**
 * Tool Executor — Phase 5 / Phase 8C
 *
 * Looks up a tool by name, calls its endpoint via fetch(), and returns
 * the result to be fed back into the LLM as a tool_result message.
 *
 * Supported kinds:
 *   searxng    — GET {searxngBaseUrl}/search?q=...&format=json  (preferred, no API key)
 *   web_search — GET tool.endpoint with Brave Search query params + auth header (legacy)
 *   http_api   — POST body as JSON to tool.endpoint
 */

import { query, queryOne } from "../db/schema";

export interface ToolCallResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Injected from Worker Env — only one needs to be set. SearXNG takes priority. */
export interface SearchConfig {
  searxngBaseUrl?: string;   // e.g. https://searxng.up.railway.app
  braveApiKey?: string;      // legacy fallback
}

interface ToolRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  endpoint: string | null;
}

// ── Agent introspection — allowed views/queries (read-only, no raw SQL) ───────
// Agents call this with toolName="query_db" and input.view = one of the keys below.
// Each key maps to a parameterized query; agents cannot pass arbitrary SQL.

const INTROSPECTION_QUERIES: Record<string, { sql: string; params: (i: Record<string, unknown>) => (string | number | null)[] }> = {
  // My recent tasks (last 24h)
  my_tasks: {
    sql: `SELECT id, kind, status, retry_count, created_at, updated_at
          FROM tasks WHERE assigned_agent_id = ?
          ORDER BY created_at DESC LIMIT 20`,
    params: (i) => [String(i["agent_id"] ?? "")],
  },
  // My stored notes / memory (sensitive keys like tokens/secrets are redacted)
  my_notes: {
    sql: `SELECT key,
            CASE WHEN key LIKE '%token%' OR key LIKE '%secret%' OR key LIKE '%password%' OR key LIKE '%key%'
                 THEN '[REDACTED — credential]'
                 ELSE value
            END AS value,
            updated_at
          FROM agent_notes WHERE agent_id = ? ORDER BY updated_at DESC`,
    params: (i) => [String(i["agent_id"] ?? "")],
  },
  // System health snapshot
  system_health: {
    sql: `SELECT * FROM system_health`,
    params: () => [],
  },
  // Active scheduled crons
  active_crons: {
    sql: `SELECT id, cron_expression, task_kind, agent_id, status, last_run_at, run_count
          FROM scheduled_crons WHERE status='active' ORDER BY created_at DESC LIMIT 20`,
    params: () => [],
  },
  // Pending proposals
  pending_proposals: {
    sql: `SELECT id, type, title, description, cron_expression, task_kind, created_at
          FROM proposals WHERE status='pending' ORDER BY created_at DESC LIMIT 10`,
    params: () => [],
  },
  // Active agents list
  agents: {
    sql: `SELECT id, name, role, domain, status FROM agents WHERE status='active' ORDER BY domain`,
    params: () => [],
  },
  // Recent failed tasks (last 4h)
  recent_failures: {
    sql: `SELECT id, kind, assigned_agent_id, retry_count, updated_at
          FROM tasks WHERE status='failed' AND updated_at > datetime('now','-4 hours')
          ORDER BY updated_at DESC LIMIT 10`,
    params: () => [],
  },
  // My cost for today
  my_cost_today: {
    sql: `SELECT SUM(
            CAST(json_extract(a.content,'$.promptTokens') AS REAL) * 0.0000005 +
            CAST(json_extract(a.content,'$.completionTokens') AS REAL) * 0.0000015
          ) as cost_usd,
          COUNT(*) as task_count
          FROM artifacts a
          JOIN tasks t ON t.id = a.task_id
          WHERE a.kind='cost'
            AND t.assigned_agent_id = ?
            AND a.created_at > date('now')`,
    params: (i) => [String(i["agent_id"] ?? "")],
  },

  // ── Skill library views ───────────────────────────────────────────────────

  // Top skills by quality score — for refinement sessions
  skill_library: {
    sql: `SELECT id, name, description, trigger_pattern, quality_score,
                 created_at, updated_at
          FROM skills
          ORDER BY quality_score DESC, updated_at DESC
          LIMIT 30`,
    params: () => [],
  },

  // Full procedure for a specific skill (pass skill_id in input)
  skill_detail: {
    sql: `SELECT s.id, s.name, s.description, s.trigger_pattern, s.procedure,
                 s.quality_score, s.created_from_task_id,
                 s.created_at, s.updated_at,
                 (SELECT COUNT(*) FROM skill_refinements r WHERE r.skill_id = s.id) AS refinement_count,
                 (SELECT SUM(r.quality_delta) FROM skill_refinements r WHERE r.skill_id = s.id) AS total_delta
          FROM skills s
          WHERE s.id = ?`,
    params: (i) => [String(i["skill_id"] ?? "")],
  },

  // Recent skill refinement history
  skill_refinements: {
    sql: `SELECT r.id, r.skill_id, s.name AS skill_name,
                 r.quality_delta, r.notes, r.refined_by, r.created_at
          FROM skill_refinements r
          JOIN skills s ON s.id = r.skill_id
          ORDER BY r.created_at DESC
          LIMIT 20`,
    params: () => [],
  },
};

export async function executeIntrospection(
  db: D1Database,
  toolInput: Record<string, unknown>,
): Promise<ToolCallResult> {
  const view = String(toolInput["view"] ?? "");
  const def = INTROSPECTION_QUERIES[view];
  if (!def) {
    const available = Object.keys(INTROSPECTION_QUERIES).join(", ");
    return { ok: false, error: `Unknown view '${view}'. Available: ${available}` };
  }
  try {
    const rows = await query<Record<string, unknown>>(db, def.sql, def.params(toolInput));
    return { ok: true, result: rows };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `query_db error: ${msg}` };
  }
}

export async function executeTool(
  db: D1Database,
  searchConfig: SearchConfig,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<ToolCallResult> {
  // ── Internal: agent introspection — bypass tool table lookup ──────────────
  if (toolName === "query_db") {
    return executeIntrospection(db, toolInput);
  }

  // ── Load tool ──────────────────────────────────────────────────────────────
  const tool = await queryOne<ToolRow>(
    db,
    "SELECT id, name, kind, status, endpoint FROM tools WHERE name = ? LIMIT 1",
    [toolName],
  );

  if (!tool) {
    return { ok: false, error: `Tool '${toolName}' not found` };
  }
  if (tool.status !== "active") {
    return { ok: false, error: `Tool '${toolName}' is not active (status: ${tool.status})` };
  }
  if (!tool.endpoint) {
    return { ok: false, error: `Tool '${toolName}' has no endpoint configured` };
  }

  // ── Dispatch by kind ───────────────────────────────────────────────────────
  try {
    if (tool.kind === "searxng") {
      // SearXNG: use the URL stored in tool.endpoint as the instance base URL,
      // overridden by SEARXNG_BASE_URL env var if present.
      const base = searchConfig.searxngBaseUrl ?? tool.endpoint;
      return await executeSearXNG(base, toolInput);
    }
    if (tool.kind === "web_search") {
      // Legacy Brave Search path — kept as fallback
      return await executeWebSearch(tool.endpoint, toolInput, searchConfig.braveApiKey);
    }
    if (tool.kind === "http_get") {
      return await executeHttpGet(tool.endpoint, toolInput);
    }
    // Default: http_api — POST JSON body
    return await executeHttpApi(tool.endpoint, toolInput);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Tool '${toolName}' fetch error: ${msg}` };
  }
}

// ── searxng: self-hosted metasearch (no API key) ──────────────────────────────

async function executeSearXNG(
  baseUrl: string,
  input: Record<string, unknown>,
): Promise<ToolCallResult> {
  const q = String(input["query"] ?? "");
  if (!q) return { ok: false, error: "web_search: missing query" };

  const count = Math.min(Number(input["count"] ?? 5), 10);
  // engines param lets SearXNG fan-out to Google + Bing + DuckDuckGo simultaneously
  const url = `${baseUrl.replace(/\/$/, "")}/search?q=${encodeURIComponent(q)}&format=json&engines=google,bing,duckduckgo&pageno=1`;

  const res = await fetch(url, {
    headers: { "Accept": "application/json" },
    // 35s covers Render free tier cold start (~30s) + search aggregation time
    signal: AbortSignal.timeout(35_000),
  });

  if (!res.ok) {
    return { ok: false, error: `SearXNG HTTP ${res.status}` };
  }

  const data = await res.json<{ results?: Array<Record<string, unknown>> }>();
  const results = (data.results ?? []).slice(0, count).map((r) => ({
    title:       r["title"]   ?? "",
    url:         r["url"]     ?? "",
    description: r["content"] ?? r["description"] ?? "",  // SearXNG uses "content"
    engine:      r["engine"]  ?? "",
  }));

  return { ok: true, result: truncateResult(results) };
}

// ── Goose MCP pattern: truncate oversized results to prevent context overflow ──
// Mirrors block/goose tool_result truncation — large payloads (e.g. full options
// chains, position dumps) are trimmed before returning to the LLM.

const MAX_RESULT_CHARS = 12_000;

function truncateResult(result: unknown): unknown {
  const str = typeof result === "string" ? result : JSON.stringify(result);
  if (str.length <= MAX_RESULT_CHARS) return result;
  const truncated = str.slice(0, MAX_RESULT_CHARS);
  return `${truncated}\n… [truncated — ${str.length - MAX_RESULT_CHARS} chars omitted]`;
}

// ── http_api: POST JSON ────────────────────────────────────────────────────────

async function executeHttpApi(
  endpoint: string,
  input: Record<string, unknown>,
): Promise<ToolCallResult> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000), // Goose pattern: always timeout tool calls
  });

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 300)}` };
  }

  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* return raw text */ }
  return { ok: true, result: truncateResult(parsed) };
}

// ── http_get: GitHub API + OSSInsight + generic GET ──────────────────────────
// endpoint is the base URL; path params from input are appended.
// For github_repo_info: endpoint=https://api.github.com/repos, input={owner,repo}
// For ossinsight_repo:  endpoint=https://api.ossinsight.io/v1/repos, input={owner,repo}

async function executeHttpGet(
  endpoint: string,
  input: Record<string, unknown>,
): Promise<ToolCallResult> {
  const owner = String(input["owner"] ?? "");
  const repo  = String(input["repo"]  ?? "");

  // Build URL: append /owner/repo if present, else use endpoint as-is
  let url = endpoint.replace(/\/$/, "");
  if (owner && repo) url = `${url}/${owner}/${repo}`;

  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "bot-nation-intel/1.0",
    },
    signal: AbortSignal.timeout(10_000),
  });

  const text = await res.text();
  if (!res.ok) return { ok: false, error: `GET ${url} → HTTP ${res.status}: ${text.slice(0, 200)}` };

  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* return raw */ }

  // For GitHub: extract the most useful fields to keep context short
  if (url.includes("api.github.com")) {
    const d = parsed as Record<string, unknown>;
    parsed = {
      name:          d["full_name"],
      description:   d["description"],
      stars:         d["stargazers_count"],
      forks:         d["forks_count"],
      language:      d["language"],
      license:       (d["license"] as Record<string, unknown> | null)?.["spdx_id"] ?? "none",
      open_issues:   d["open_issues_count"],
      last_push:     d["pushed_at"],
      created_at:    d["created_at"],
      topics:        d["topics"],
      archived:      d["archived"],
      homepage:      d["homepage"],
      url:           d["html_url"],
    };
  }

  return { ok: true, result: parsed };
}

// ── web_search: Brave Search API ──────────────────────────────────────────────

async function executeWebSearch(
  endpoint: string,
  input: Record<string, unknown>,
  apiKey: string | undefined,
): Promise<ToolCallResult> {
  if (!apiKey) {
    return { ok: false, error: "web_search not configured: missing BRAVE_SEARCH_API_KEY" };
  }

  const query = String(input["query"] ?? "");
  const count = Math.min(Number(input["count"] ?? 5), 10);
  const url = `${endpoint}?q=${encodeURIComponent(query)}&count=${count}`;

  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": apiKey,
    },
  });

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, error: `Brave Search HTTP ${res.status}: ${text.slice(0, 200)}` };
  }

  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    return { ok: false, error: "Brave Search returned non-JSON response" };
  }

  // Extract just the useful fields from Brave's response
  const data = parsed as Record<string, unknown>;
  const webResults = (data["web"] as { results?: unknown[] } | undefined)?.results ?? [];
  const results = (webResults as Array<Record<string, unknown>>).map((r) => ({
    title: r["title"],
    url: r["url"],
    description: r["description"],
  }));

  return { ok: true, result: results };
}
