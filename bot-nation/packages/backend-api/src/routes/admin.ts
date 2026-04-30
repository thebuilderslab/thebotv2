/**
 * Admin Routes — operator utilities (R16, Phase A.5).
 *
 * POST /api/admin/replay-task-output?task_id=<uuid>
 *   Re-format and re-send a completed task's output to its Telegram chat.
 *   Used to recover the 04-30 trading brief that silently dropped, and any
 *   future drops surfaced by `events.kind = 'telegram.send_failed'`.
 */

import { Hono } from "hono";
import type { Env } from "../index";
import { queryOne } from "../db/schema";
import { formatForTelegram, stripHtmlToPlain } from "../utils/telegram-format";

export const adminRouter = new Hono<{ Bindings: Env }>();

adminRouter.post("/api/admin/replay-task-output", async (c) => {
  const taskId = c.req.query("task_id");
  if (!taskId) return c.json({ error: "task_id required" }, 400);
  if (!c.env.TELEGRAM_BOT_TOKEN) return c.json({ error: "TELEGRAM_BOT_TOKEN not configured" }, 500);

  const task = await queryOne<{
    id: string;
    kind: string;
    input: string;
    output: string | null;
    telegram_chat_id: number | null;
    assigned_agent_id: string | null;
  }>(
    c.env.DB,
    "SELECT id, kind, input, output, telegram_chat_id, assigned_agent_id FROM tasks WHERE id = ?",
    [taskId],
  );
  if (!task) return c.json({ error: "task not found" }, 404);
  if (!task.telegram_chat_id) return c.json({ error: "task has no telegram_chat_id" }, 400);
  if (!task.output) return c.json({ error: "task has no output to replay" }, 400);

  // Mirror AgentActor's label extraction so the replayed message looks like the original.
  let taskLabel = task.kind;
  try {
    const inp = JSON.parse(task.input) as { summary?: string };
    if (inp.summary) taskLabel = inp.summary;
  } catch { /* ignore */ }

  const escapedLabel = taskLabel.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const header = `📋 <b>Replayed:</b> <i>${escapedLabel}</i>`;
  const footer = `<code>/status ${task.id}</code>`;

  const chunks = formatForTelegram(task.output, header, footer);

  const sentChunks: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const payload: Record<string, unknown> = {
      chat_id: task.telegram_chat_id,
      text: chunk.text,
    };
    if (chunk.parseMode) payload.parse_mode = chunk.parseMode;

    const resp = await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => "");
      // Plain-text retry for HTML chunks
      if (chunk.parseMode === "HTML") {
        const retry = await fetch(`https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: task.telegram_chat_id,
            text: stripHtmlToPlain(chunk.text),
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (retry.ok) {
          sentChunks.push(i);
          continue;
        }
      }
      return c.json({
        error: "send_failed",
        chunkIndex: i,
        totalChunks: chunks.length,
        sentChunks,
        status: resp.status,
        body: errBody.slice(0, 500),
      }, 502);
    }
    sentChunks.push(i);
  }

  return c.json({
    ok: true,
    task_id: task.id,
    chunks_sent: sentChunks.length,
    total_chunks: chunks.length,
  });
});
