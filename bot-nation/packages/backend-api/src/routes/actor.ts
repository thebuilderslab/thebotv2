/**
 * Actor routes — Phase 6
 * Handles WebSocket upgrades, manual dispatch, and session status.
 */

import { AutoRouter, type IRequest } from "itty-router";
import type { Env } from "../index";
import { query, queryOne, run, claimRow } from "../db/schema";

export const actorRouter = AutoRouter<IRequest, [Env, ExecutionContext]>();

// ─── GET /api/actors/:agentId/connect ─────────────────────────────────────────
// Upgrades to WebSocket → proxied into the agent's DO

actorRouter.get("/api/actors/:agentId/connect", async (req, env) => {
  const agentId = req.params["agentId"];
  if (!agentId) return new Response("Bad Request", { status: 400 });

  const upgrade = req.headers.get("Upgrade");
  if (upgrade?.toLowerCase() !== "websocket") {
    return Response.json({ error: "WebSocket upgrade required" }, { status: 426 });
  }

  const doId = env.AGENT_ACTOR.idFromName(agentId);
  const stub = env.AGENT_ACTOR.get(doId);
  return stub.fetch(new Request("https://do/ws", req as unknown as Request));
});

// ─── POST /api/actors/:agentId/dispatch ───────────────────────────────────────
// Manually enqueue a task to an agent's DO (bypasses cron)

actorRouter.post("/api/actors/:agentId/dispatch", async (req, env) => {
  const agentId = req.params["agentId"];
  if (!agentId) return new Response("Bad Request", { status: 400 });

  const { taskId } = await req.json<{ taskId: string }>();
  if (!taskId) return Response.json({ error: "taskId required" }, { status: 400 });

  const now = new Date().toISOString();
  const sessionId = crypto.randomUUID();

  // Universal CAS (#1): only the first manual dispatch gets to flip pending→running.
  // A double-tap on the dispatch button or a cron-vs-manual race silently no-ops.
  const claimed = await claimRow(env.DB, "tasks", taskId, {
    fromStatus: "pending",
    toStatus:   "running",
    claimedBy:  `manual_dispatch:${agentId}`,
    extraSets:  "session_id=?",
    extraParams: [sessionId],
  });
  if (!claimed) {
    return Response.json({ error: "task not in pending state — already dispatched" }, { status: 409 });
  }

  await run(
    env.DB,
    `INSERT INTO agent_sessions (id, agent_id, task_id, status, ws_connected, started_at, updated_at)
     VALUES (?, ?, ?, 'running', 0, ?, ?)`,
    [sessionId, agentId, taskId, now, now],
  );

  const doId = env.AGENT_ACTOR.idFromName(agentId);
  const stub = env.AGENT_ACTOR.get(doId);
  await stub.fetch("https://do/enqueue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskId, sessionId }),
  });

  return Response.json({ sessionId, queued: true }, { status: 201 });
});

// ─── GET /api/actors/:agentId/session ─────────────────────────────────────────
// Latest session for this agent

actorRouter.get("/api/actors/:agentId/session", async (req, env) => {
  const agentId = req.params["agentId"];
  if (!agentId) return new Response("Bad Request", { status: 400 });

  const session = await queryOne(
    env.DB,
    "SELECT * FROM agent_sessions WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1",
    [agentId],
  );
  return Response.json(session ?? { status: "idle" });
});

// ─── GET /api/actors/:agentId/sessions ────────────────────────────────────────
// Session history

actorRouter.get("/api/actors/:agentId/sessions", async (req, env) => {
  const agentId = req.params["agentId"];
  if (!agentId) return new Response("Bad Request", { status: 400 });

  const sessions = await query(
    env.DB,
    "SELECT * FROM agent_sessions WHERE agent_id = ? ORDER BY started_at DESC LIMIT 50",
    [agentId],
  );
  return Response.json(sessions);
});

// ─── GET /api/actors/:agentId/status ──────────────────────────────────────────
// Live DO status (queue length, ws connections)

actorRouter.get("/api/actors/:agentId/status", async (req, env) => {
  const agentId = req.params["agentId"];
  if (!agentId) return new Response("Bad Request", { status: 400 });

  const doId = env.AGENT_ACTOR.idFromName(agentId);
  const stub = env.AGENT_ACTOR.get(doId);
  return stub.fetch("https://do/status");
});
