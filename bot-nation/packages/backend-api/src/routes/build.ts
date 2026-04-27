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
import { persistTelegramMessage } from "../services/nation-supervisor";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── GitHub dispatch helper — exported so telegram.ts callback can call it ────

export async function dispatchChangeToGitHub(
  env: Env,
  changeId: string,
): Promise<{ ok: boolean; error?: string; alreadyDispatched?: boolean }> {
  const row = await queryOne<{
    id: string; files: string; commit_message: string;
    task_id: string | null; chat_id: string | null;
    status: string;
  }>(
    env.DB,
    "SELECT id, files, commit_message, task_id, chat_id, status FROM code_changes WHERE id = ?",
    [changeId],
  );

  if (!row) return { ok: false, error: "Change not found" };

  // ── Idempotency CAS: only dispatch from pending_approval ─────────────────
  // Atomically transition pending_approval → dispatching. If 0 rows updated,
  // someone else (a duplicate button tap, replayed update) won the race.
  const now = new Date().toISOString();
  const claim = await env.DB.prepare(
    "UPDATE code_changes SET status='dispatching', updated_at=? WHERE id=? AND status='pending_approval'",
  ).bind(now, changeId).run();
  if (!claim.meta.changes) {
    return {
      ok: false,
      alreadyDispatched: true,
      error: `Change already in status '${row.status}' — dispatch skipped (duplicate tap or replay)`,
    };
  }

  const githubToken = (env as unknown as Record<string, string>)["GITHUB_TOKEN"];
  if (!githubToken) {
    // Roll back the claim so the operator can retry once the token is configured
    await run(env.DB, "UPDATE code_changes SET status='pending_approval', updated_at=? WHERE id=?", [now, changeId]);
    return { ok: false, error: "GITHUB_TOKEN not configured" };
  }

  const dispatchPayload = {
    event_type: "bot-nation-deploy",
    client_payload: {
      change_id:      changeId,
      task_id:        row.task_id ?? changeId,
      chat_id:        row.chat_id ?? (env as unknown as Record<string, string>)["TELEGRAM_CHAT_ID"] ?? "",
      commit_message: row.commit_message.slice(0, 200),
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

  const after = new Date().toISOString();
  if (!ghResp.ok) {
    const errText = await ghResp.text();
    await run(env.DB, "UPDATE code_changes SET status='failed', updated_at=? WHERE id=?", [after, changeId]);
    return { ok: false, error: `GitHub dispatch failed ${ghResp.status}: ${errText.slice(0, 200)}` };
  }

  await run(env.DB, "UPDATE code_changes SET status='dispatched', updated_at=? WHERE id=?", [after, changeId]);
  return { ok: true };
}

export const buildRouter = new Hono<{ Bindings: Env }>();

const GITHUB_OWNER = "thebuilderslab";
const GITHUB_REPO  = "thebotv2";

// Paths the agent is allowed to read/write (safety fence — no secrets or CI files).
// Repo layout is `<repo>/bot-nation/packages/...` so all paths MUST start with `bot-nation/`.
const ALLOWED_PATH_PREFIXES = [
  "bot-nation/packages/backend-api/src/",
  "bot-nation/packages/backend-api/migrations/",
  "bot-nation/packages/frontend-app/src/",
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
// Stores change in D1 as pending_approval, sends Telegram preview with
// Approve/Cancel buttons.  Dispatch to GitHub only happens on ✅ Approve.

buildRouter.post("/api/build/submit", async (c) => {
  let body: {
    files?: Array<{ path: string; content: string }>;
    commit_message?: string;
    change_summary?: string;   // agent-written plain-text description of what changed
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

  const now = new Date().toISOString();
  const chatId = body.chat_id ?? c.env.TELEGRAM_CHAT_ID ?? "";
  const filesJson = JSON.stringify(body.files);

  // ── Bug 5 fix (Apr 2026): preview-level dedup ──────────────────────────────
  // If an open pending_approval already exists with the SAME files + commit
  // message within the last 30 min, reuse it instead of creating a duplicate
  // change_id + preview. CAS in dispatchChangeToGitHub only protects per-id;
  // duplicate ids would each spawn their own preview + button.
  const dedupCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const existing = await queryOne<{ id: string }>(
    c.env.DB,
    `SELECT id FROM code_changes
     WHERE status='pending_approval'
       AND commit_message=?
       AND files=?
       AND created_at > ?
     ORDER BY created_at DESC LIMIT 1`,
    [body.commit_message, filesJson, dedupCutoff],
  );
  if (existing) {
    return c.json({
      status:        "pending_approval",
      change_id:     existing.id,
      deduped:       true,
      files_changed: body.files.length,
      message:       `Identical pending change already awaiting approval (${existing.id}). Preview not re-sent.`,
    });
  }

  const id = crypto.randomUUID();

  // Store in D1 as pending_approval (not dispatched yet — waits for operator ✅)
  await run(c.env.DB,
    `INSERT INTO code_changes (id, task_id, agent_id, files, commit_message, status, chat_id, created_at, updated_at)
     VALUES (?, ?, 'agent-build-lead', ?, ?, 'pending_approval', ?, ?, ?)`,
    [id, body.task_id ?? null, filesJson, body.commit_message,
     chatId ? String(chatId) : null, now, now],
  );

  // ── Send Telegram preview with Approve / Cancel buttons ──────────────────
  if (c.env.TELEGRAM_BOT_TOKEN && chatId) {
    const fileLines = body.files.map((f) => `  📄 <code>${escapeHtml(f.path)}</code>`).join("\n");
    const firstFile  = body.files[0];
    // Show first ~600 chars of the changed file — enough to judge the change
    const snippet = escapeHtml(firstFile.content.slice(0, 600));
    const truncated = firstFile.content.length > 600
      ? `\n<i>… +${firstFile.content.length - 600} more chars</i>` : "";

    const summaryLine = body.change_summary
      ? `\n\n📝 <b>What changed:</b>\n${escapeHtml(body.change_summary)}`
      : "";

    const previewText =
      `🔍 <b>Code change ready — review before deploying</b>\n\n` +
      `<b>Commit:</b> <i>${escapeHtml(body.commit_message)}</i>\n\n` +
      `<b>Files (${body.files.length}):</b>\n${fileLines}` +
      summaryLine +
      `\n\n<b>Preview (<code>${escapeHtml(firstFile.path)}</code>):</b>\n` +
      `<pre>${snippet}</pre>${truncated}\n\n` +
      `Tap ✅ to deploy or ❌ to cancel.`;

    const keyboard = {
      inline_keyboard: [[
        { text: "✅ Deploy it", callback_data: `build_approve:${id}` },
        { text: "❌ Cancel",    callback_data: `build_cancel:${id}` },
      ]],
    };

    await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:      String(chatId),
        text:         previewText,
        parse_mode:   "HTML",
        reply_markup: keyboard,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    // Log outbound so supervisor gap-detection sees the reply
    void persistTelegramMessage(c.env.DB, "out", chatId, previewText, {
      taskId: body.task_id ?? undefined,
      routeType: "deploy_preview",
    });
  }

  return c.json({
    status:        "pending_approval",
    change_id:     id,
    files_changed: body.files.length,
    message:       `Preview sent to Telegram. Tap ✅ Deploy to trigger GitHub Actions deployment, or ❌ Cancel to abort.`,
  });
});

// ── POST /api/build/edit-section ─────────────────────────────────────────────
// Surgical single-section edit. Agent sends {path, old_string, new_string} —
// the endpoint reads the current file from GitHub, validates that old_string
// appears exactly once, swaps it for new_string, and submits the result
// through the same pending_approval + Telegram preview flow as submit.
//
// Big win: agent sends ~500 tokens instead of regenerating a ~12k-token file.

buildRouter.post("/api/build/edit-section", async (c) => {
  const githubToken = c.env.GITHUB_TOKEN;
  if (!githubToken) return c.json({ error: "GITHUB_TOKEN not configured" }, 500);

  let body: {
    path?: string;
    old_string?: string;
    new_string?: string;
    commit_message?: string;
    change_summary?: string;
    task_id?: string;
    chat_id?: string | number;
  };
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid JSON body" }, 400); }

  if (!body.path)           return c.json({ error: "path is required" }, 400);
  if (body.old_string == null)  return c.json({ error: "old_string is required" }, 400);
  if (body.new_string == null)  return c.json({ error: "new_string is required" }, 400);
  if (!body.commit_message) return c.json({ error: "commit_message is required" }, 400);
  if (!body.change_summary) return c.json({ error: "change_summary is required" }, 400);
  if (!isPathAllowed(body.path)) {
    return c.json({
      error: `Path not allowed: ${body.path}. Allowed prefixes: ${ALLOWED_PATH_PREFIXES.join(", ")}`,
    }, 400);
  }
  if (body.old_string === body.new_string) {
    return c.json({ error: "old_string and new_string are identical — nothing to change" }, 400);
  }
  if (body.old_string.length === 0) {
    return c.json({ error: "old_string must be non-empty (use submit_code_change to create a new file)" }, 400);
  }

  // ── 1. Read current file from GitHub ──────────────────────────────────────
  const clean = body.path.replace(/^\.\//, "").replace(/\\/g, "/");
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${clean}`;
  const resp = await fetch(apiUrl, {
    headers: {
      "Authorization": `Bearer ${githubToken}`,
      "Accept":        "application/vnd.github.raw+json",
      "User-Agent":    "bot-nation-agent/1.0",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    if (resp.status === 404) {
      return c.json({
        error: `File does not exist: ${clean}. Use submit_code_change to create new files.`,
      }, 404);
    }
    return c.json({ error: `GitHub API ${resp.status} reading file` }, 502);
  }
  const currentContent = await resp.text();

  // ── 2. Validate uniqueness of old_string ──────────────────────────────────
  const idx = currentContent.indexOf(body.old_string);
  if (idx === -1) {
    return c.json({
      error: `old_string not found in ${clean}. The file may have changed, or your match isn't verbatim. Tip: re-read the file with read_github_file and check whitespace/indentation.`,
    }, 422);
  }
  // Check for a second occurrence — must be exactly one match.
  if (currentContent.indexOf(body.old_string, idx + 1) !== -1) {
    return c.json({
      error: `old_string matches more than once in ${clean}. Add 1–3 lines of surrounding context to make it unique.`,
    }, 422);
  }

  // ── 3. Apply the patch ────────────────────────────────────────────────────
  const newContent =
    currentContent.slice(0, idx) +
    body.new_string +
    currentContent.slice(idx + body.old_string.length);

  // ── 4. Submit through the same pending_approval flow ──────────────────────
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();
  const chatId = body.chat_id ?? c.env.TELEGRAM_CHAT_ID ?? "";
  const files = [{ path: clean, content: newContent }];

  await run(c.env.DB,
    `INSERT INTO code_changes (id, task_id, agent_id, files, commit_message, status, chat_id, created_at, updated_at)
     VALUES (?, ?, 'agent-build-lead', ?, ?, 'pending_approval', ?, ?, ?)`,
    [id, body.task_id ?? null, JSON.stringify(files), body.commit_message,
     chatId ? String(chatId) : null, now, now],
  );

  // ── 5. Telegram preview (showing the diff snippet, not the whole file) ────
  if (c.env.TELEGRAM_BOT_TOKEN && chatId) {
    const oldSnippet = escapeHtml(body.old_string.slice(0, 400));
    const newSnippet = escapeHtml(body.new_string.slice(0, 400));
    const oldTrunc = body.old_string.length > 400 ? `\n<i>… +${body.old_string.length - 400} more chars</i>` : "";
    const newTrunc = body.new_string.length > 400 ? `\n<i>… +${body.new_string.length - 400} more chars</i>` : "";

    const previewText =
      `🔍 <b>Surgical edit ready — review before deploying</b>\n\n` +
      `<b>Commit:</b> <i>${escapeHtml(body.commit_message)}</i>\n\n` +
      `<b>File:</b> <code>${escapeHtml(clean)}</code>\n\n` +
      `📝 <b>What changed:</b>\n${escapeHtml(body.change_summary)}\n\n` +
      `<b>− Removed:</b>\n<pre>${oldSnippet}</pre>${oldTrunc}\n\n` +
      `<b>+ Added:</b>\n<pre>${newSnippet}</pre>${newTrunc}\n\n` +
      `Tap ✅ to deploy or ❌ to cancel.`;

    const keyboard = {
      inline_keyboard: [[
        { text: "✅ Deploy it", callback_data: `build_approve:${id}` },
        { text: "❌ Cancel",    callback_data: `build_cancel:${id}` },
      ]],
    };

    await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:      String(chatId),
        text:         previewText,
        parse_mode:   "HTML",
        reply_markup: keyboard,
      }),
      signal: AbortSignal.timeout(5_000),
    });
  }

  return c.json({
    status:        "pending_approval",
    change_id:     id,
    path:          clean,
    bytes_changed: body.new_string.length - body.old_string.length,
    message:       `Preview sent to Telegram. Tap ✅ Deploy to trigger GitHub Actions deployment, or ❌ Cancel to abort.`,
  });
});

// ── POST /api/build/change/:id/approve ───────────────────────────────────────
// Operator approves the preview → dispatches to GitHub Actions.
// Also called internally by the Telegram callback handler.

buildRouter.post("/api/build/change/:id/approve", async (c) => {
  const changeId = c.req.param("id");
  const result = await dispatchChangeToGitHub(c.env, changeId);
  if (!result.ok) return c.json({ error: result.error }, 502);
  return c.json({ ok: true, message: "Dispatched to GitHub Actions. ~2 min to deploy." });
});

// ── POST /api/build/change/:id/cancel ────────────────────────────────────────

buildRouter.post("/api/build/change/:id/cancel", async (c) => {
  const changeId = c.req.param("id");
  const now = new Date().toISOString();
  await run(c.env.DB, "UPDATE code_changes SET status='cancelled', updated_at=? WHERE id=?", [now, changeId]);
  return c.json({ ok: true });
});

// ── POST /api/build/log-outbound ─────────────────────────────────────────────
// Called by GitHub Actions after it sends Telegram success/failure messages
// so supervisor gap-detection sees the reply and doesn't flag the originating
// query as "unanswered". Authenticated by DEPLOY_WEBHOOK_SECRET.
buildRouter.post("/api/build/log-outbound", async (c) => {
  const secret = c.req.header("x-deploy-secret");
  if (!secret || secret !== (c.env as unknown as Record<string, string>)["DEPLOY_WEBHOOK_SECRET"]) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const body = await c.req.json<{
    chat_id: string | number;
    text: string;
    task_id?: string;
    route_type?: string;
  }>();
  if (!body.chat_id || !body.text) return c.json({ error: "chat_id and text required" }, 400);
  void persistTelegramMessage(c.env.DB, "out", body.chat_id, body.text, {
    taskId: body.task_id,
    routeType: body.route_type ?? "deploy_notification",
  });
  return c.json({ ok: true });
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
