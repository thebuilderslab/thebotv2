/**
 * Tool Executor — Phase 5
 *
 * Looks up a tool by name, calls its endpoint via fetch(), and returns
 * the result to be fed back into Claude as a tool_result message.
 *
 * Supported kinds:
 *   http_api   — POST body as JSON to tool.endpoint
 *   web_search — GET tool.endpoint with Brave Search query params + auth header
 */

import { queryOne } from "../db/schema";

export interface ToolCallResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface ToolRow {
  id: string;
  name: string;
  kind: string;
  status: string;
  endpoint: string | null;
}

export async function executeTool(
  db: D1Database,
  braveApiKey: string | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
): Promise<ToolCallResult> {
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
    if (tool.kind === "web_search") {
      return await executeWebSearch(tool.endpoint, toolInput, braveApiKey);
    }
    // Default: http_api — POST JSON body
    return await executeHttpApi(tool.endpoint, toolInput);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Tool '${toolName}' fetch error: ${msg}` };
  }
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
  });

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
  }

  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* return raw text */ }
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
