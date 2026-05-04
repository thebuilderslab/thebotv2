/**
 * Admin Routes — operator utilities (R16, Phase A.5).
 *
 * POST /api/admin/replay-task-output/:taskId
 * POST /api/admin/replay-task-output?task_id=<uuid>   (legacy query-param form)
 *   Re-deliver a completed task's body to its Telegram chat without
 *   regenerating the agent run.
 *
 * PR A3 cutover: this route now forwards to AgentActor's DO /replay-completion
 * handler so all replay traffic goes through the PR A2-verified render path
 * (escapeAgentHtml + chunkPreRenderedTelegramHtml). The previous handler
 * called formatForTelegram on already-rendered HTML and double-escaped the
 * body — see PR A2 commit 17763ce for the failure class.
 */

import { Hono } from "hono";
import type { Env } from "../index";
import { queryOne } from "../db/schema";

export const adminRouter = new Hono<{ Bindings: Env }>();

function checkAuth(env: Env, header: string | undefined): Response | null {
  const expected = (env as unknown as Record<string, string>)["DEPLOY_WEBHOOK_SECRET"];
  if (!expected) {
    return Response.json({ error: "DEPLOY_WEBHOOK_SECRET not configured" }, { status: 500 });
  }
  if (!header || header !== expected) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

async function forwardReplayToDO(
  env: Env,
  taskId: string,
): Promise<Response> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    return Response.json({ error: "TELEGRAM_BOT_TOKEN not configured" }, { status: 500 });
  }

  const task = await queryOne<{
    id: string;
    telegram_chat_id: number | null;
    output: string | null;
    assigned_agent_id: string | null;
  }>(
    env.DB,
    "SELECT id, telegram_chat_id, output, assigned_agent_id FROM tasks WHERE id = ?",
    [taskId],
  );
  if (!task) return Response.json({ error: "task not found" }, { status: 404 });
  if (!task.telegram_chat_id) {
    return Response.json({ error: "task has no telegram_chat_id" }, { status: 400 });
  }
  if (!task.output) {
    return Response.json({ error: "task has no output to replay" }, { status: 400 });
  }
  if (!task.assigned_agent_id) {
    return Response.json({ error: "task has no assigned_agent_id (cannot resolve DO)" }, { status: 400 });
  }

  const stub = env.AGENT_ACTOR.get(env.AGENT_ACTOR.idFromName(task.assigned_agent_id));
  const resp = await stub.fetch("https://internal/replay-completion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId }),
  });

  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: { "Content-Type": "application/json" },
  });
}

adminRouter.post("/api/admin/replay-task-output/:taskId", async (c) => {
  const authFail = checkAuth(c.env, c.req.header("x-deploy-secret"));
  if (authFail) return authFail;
  const taskId = c.req.param("taskId");
  if (!taskId) return c.json({ error: "taskId required" }, 400);
  return forwardReplayToDO(c.env, taskId);
});

adminRouter.post("/api/admin/replay-task-output", async (c) => {
  const authFail = checkAuth(c.env, c.req.header("x-deploy-secret"));
  if (authFail) return authFail;
  const taskId = c.req.query("task_id");
  if (!taskId) return c.json({ error: "task_id required" }, 400);
  return forwardReplayToDO(c.env, taskId);
});
