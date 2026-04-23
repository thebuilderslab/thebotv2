/**
 * Build Routes — Self-Modification Pipeline
 *
 * POST /api/build/submit          — agent submits code change → triggers GitHub Actions
 * GET  /api/build/change/:id      — GitHub Actions fetches change details
 * POST /api/build/change/:id/status — GitHub Actions marks change deployed/failed
 * POST /api/build/read-file       — agent reads current file content from GitHub
 *
 * Flow:
 *   agent-build-lead
 *     → calls read_github_file (reads current content)
 *     → generates modified content
 *     → calls submit_code_change (POST /api/build/submit)
 *     → Worker stores in D1, dispatches repository_dispatch to GitHub
 *     → GitHub Actions: apply files → wrangler deploy → notify Telegram
 */

import { Hono } from "hono";
import type { Env } from "../index";
import { run, queryOne } from "../db/schema";

export const buildRouter = new Hono<{ Bindings: Env }>();

const GITHUB_OWNER = "thebuilderslab";
const GITHUB_REPO  = "thebotv2";

// Paths the agent is allowed to read/write (safety fence — no secrets or CI files)
const ALLOWED_PATH_PREFIXES = [
  "packages/backend-api/src/",
  "packages/backend-api/migrations/",
  "packages/frontend-app/src/",
];

// Paths that can never be written by the agent
const BLOCKED_PATHS = [
  ".env",
  "wrangler.jsonc",
  "wrangler.toml",
  ".github/",
  "package-lock.json",
];

function isPathAllowed(p: string): boolean {
  const clean = p.replace(/^\.\//, "").replace(/\\/g, "/");
  if (BLOCKED_PATHS.some((b) => clean.startsWith(b) || clean === b)) return false;
  return ALLOWED_PATH_PREFIXES.some((prefix) => clean.startsWith(prefix));
}

// ── POST /api/build/submit ────────────────────────────────────────────────────
// Called by agent-build-lead (submit_code_change tool).
// Stores change in D1, fires GitHub repository_dispatch.

buildRouter.post("/api/build/submit", async (c) => {
  const githubToken = c.env.GITHUB_TOKEN;
  if (!githubToken) {
    return c.json({ error: "GITHUB_TOKEN not configured. Run: npx wrangler secret put GITHUB_TOKEN" }, 500);
  }

  let body: {
    files?: Array<{ path: string; content: string }>;
    commit_message?: string;
    task_id?: string;
    chat_id?: string | number;
  };

  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.files || !Array.isArray(body.files) || body.files.length === 0) {
    return c.json({ error: "files array is required" }, 400);
  }
  if (!body.commit_message) {
    return c.json({ error: "commit_message is required" }, 400);
  }

  // Validate all paths
  for (const f of body.files) {
    if (!isPathAllowed(f.path)) {
      return c.json({
        error: `Path not allowed: ${f.path}. Allowed prefixes: ${ALLOWED_PATH_PREFIXES.join(", ")}`,
      }, 400);
    }
    if (!f.content) {
      return c.json({ error: `File content is empty for: ${f.path}` }, 400);
    }
  }

  const id  = crypto.randomUUID();
  const now = new Date().toISOString();

  // Store in D1
  await run(c.env.DB,
    `INSERT INTO code_changes (id, task_id, agent_id, files, commit_message, status, chat_id, created_at, updated_at)
     VALUES (?, ?, 'agent-build-lead', ?, ?, 'pending', ?, ?, ?)`,
    [
      id,
      body.task_id ?? null,
      JSON.stringify(body.files),
      body.commit_message,
      body.chat_id ? String(body.chat_id) : null,
      now, now,
    ],
  );

  // Dispatch to GitHub Actions
  const dispatchPayload = {
    event_type: "bot-nation-deploy",
    client_payload: {
      change_id:      id,
      task_id:        body.task_id ?? id,
      chat_id:        body.chat_id ?? c.env.TELEGRAM_CHAT_ID ?? "",
      commit_message: body.commit_message.slice(0, 200),
    },
  };

  const ghResp = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`,
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${githubToken}`,
        "Accept":        "application/vnd.github+json",
        "Content-Type":  "application/json",
        "User-Agent":    "bot-nation-agent/1.0",
      },
      body: JSON.stringify(dispatchPayload),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!ghResp.ok) {
    const errText = await ghResp.text();
    await run(c.env.DB,
      "UPDATE code_changes SET status='failed', updated_at=? WHERE id=?",
      [now, id],
    );
    return c.json({ error: `GitHub dispatch failed ${ghResp.status}: ${errText.slice(0, 200)}` }, 502);
  }

  // Mark dispatched
  await run(c.env.DB,
    "UPDATE code_changes SET status='dispatched', updated_at=? WHERE id=?",
    [new Date().toISOString(), id],
  );

  return c.json({
    status:         "dispatched",
    change_id:      id,
    files_changed:  body.files.length,
    message:        `Change dispatched to GitHub Actions. Deployment will complete in ~2 min. Results will be sent to Telegram.`,
  });
});

// ── GET /api/build/change/:id ─────────────────────────────────────────────────
// Called by GitHub Actions to fetch file content.
// Authenticated by DEPLOY_WEBHOOK_SECRET header.

buildRouter.get("/api/build/change/:id", async (c) => {
  const secret = c.req.header("x-deploy-secret");
  if (!secret || secret !== (c.env as unknown as Record<string,string>)["DEPLOY_WEBHOOK_SECRET"]) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const id = c.req.param("id");
  const row = await queryOne<{
    id: string; files: string; commit_message: string;
    task_id: string | null; agent_id: string; chat_id: string | null;
  }>(
    c.env.DB,
    "SELECT id, files, commit_message, task_id, agent_id, chat_id FROM code_changes WHERE id = ?",
    [id],
  );

  if (!row) return c.json({ error: "Change not found" }, 404);

  return c.json({
    id:             row.id,
    files:          JSON.parse(row.files) as unknown[],
    commit_message: row.commit_message,
    task_id:        row.task_id,
    agent_id:       row.agent_id,
  });
});

// ── POST /api/build/change/:id/status ────────────────────────────────────────
// GitHub Actions calls this on completion to update D1 status.

buildRouter.post("/api/build/change/:id/status", async (c) => {
  const secret = c.req.header("x-deploy-secret");
  if (!secret || secret !== (c.env as unknown as Record<string,string>)["DEPLOY_WEBHOOK_SECRET"]) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const id = c.req.param("id");
  let body: { status?: string; run_url?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }

  const now = new Date().toISOString();
  await run(c.env.DB,
    "UPDATE code_changes SET status=?, run_url=?, updated_at=? WHERE id=?",
    [body.status ?? "deployed", body.run_url ?? null, now, id],
  );

  return c.json({ ok: true });
});

// ── POST /api/build/read-file ──────────────────────────────────────────────────
// Agent tool — read a file from GitHub to get current content before editing.

buildRouter.post("/api/build/read-file", async (c) => {
  const githubToken = c.env.GITHUB_TOKEN;
  if (!githubToken) {
    return c.json({ error: "GITHUB_TOKEN not configured" }, 500);
  }

  let body: { path?: string };
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON" }, 400); }

  if (!body.path) return c.json({ error: "path is required" }, 400);

  const clean = body.path.replace(/^\.\//, "").replace(/\\/g, "/");
  if (!ALLOWED_PATH_PREFIXES.some((p) => clean.startsWith(p))) {
    return c.json({ error: `Path not in allowed prefixes. Allowed: ${ALLOWED_PATH_PREFIXES.join(", ")}` }, 400);
  }

  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${clean}`;
  const resp = await fetch(apiUrl, {
    headers: {
      "Authorization": `Bearer ${githubToken}`,
      "Accept":        "application/vnd.github.raw+json",  // returns raw content directly
      "User-Agent":    "bot-nation-agent/1.0",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!resp.ok) {
    if (resp.status === 404) {
      return c.json({ content: "", exists: false, path: clean, message: "File does not exist yet — you are creating it new." });
    }
    return c.json({ error: `GitHub API ${resp.status}` }, 502);
  }

  const content = await resp.text();
  return c.json({
    path:    clean,
    exists:  true,
    content,
    lines:   content.split("\n").length,
  });
});

// ── GET /api/build/changes ────────────────────────────────────────────────────
// Dashboard: list recent code changes.

buildRouter.get("/api/build/changes", async (c) => {
  const { query } = await import("../db/schema");
  const rows = await query<{
    id: string; commit_message: string; status: string;
    files: string; run_url: string | null; created_at: string;
  }>(
    c.env.DB,
    `SELECT id, commit_message, status, files, run_url, created_at
     FROM code_changes ORDER BY created_at DESC LIMIT 20`,
    [],
  );

  return c.json({
    changes: rows.map((r) => ({
      ...r,
      file_count: (JSON.parse(r.files) as unknown[]).length,
      files: undefined,
    })),
    count: rows.length,
  });
});
