import { AutoRouter, type IRequest } from "itty-router";
import type { Env } from "../index";
import { query, queryOne, run } from "../db/schema";
import type { Task } from "@bot-nation/core-domain";
import { routeTask } from "../services/task-router";

export const tasksRouter = AutoRouter<IRequest, [Env, ExecutionContext]>();

// ─── GET /api/tasks ──────────────────────────────────────────────────────────
// Optional: ?status=pending|running|completed|failed  ?teamId=<uuid>

tasksRouter.get("/api/tasks", async (req, env) => {
  const rawStatus = req.query["status"];
  const rawTeamId = req.query["teamId"];
  const status = Array.isArray(rawStatus) ? rawStatus[0] : rawStatus;
  const teamId = Array.isArray(rawTeamId) ? rawTeamId[0] : rawTeamId;

  const conditions: string[] = [];
  const params: string[] = [];

  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }
  if (teamId) {
    conditions.push("team_id = ?");
    params.push(teamId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await query<Task>(
    env.DB,
    `SELECT * FROM tasks ${where} ORDER BY created_at DESC`,
    params,
  );
  return Response.json(rows);
});

// ─── GET /api/tasks/:id/events ───────────────────────────────────────────────
// Must be registered BEFORE /:id to avoid route shadowing.

tasksRouter.get("/api/tasks/:id/events", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });

  const task = await queryOne<{ id: string; approval_id: string | null }>(
    env.DB,
    "SELECT id, approval_id FROM tasks WHERE id = ?",
    [id],
  );
  if (!task) return new Response("Not found", { status: 404 });

  // Events targeting the task itself OR its linked approval
  const ids = [task.id, task.approval_id].filter(Boolean) as string[];
  const placeholders = ids.map(() => "?").join(", ");
  const events = await query(
    env.DB,
    `SELECT * FROM events WHERE target_id IN (${placeholders}) ORDER BY created_at ASC`,
    ids,
  );
  return Response.json(events);
});

// ─── GET /api/tasks/:id ──────────────────────────────────────────────────────

tasksRouter.get("/api/tasks/:id", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });
  const task = await queryOne<Task>(env.DB, "SELECT * FROM tasks WHERE id = ?", [id]);
  if (!task) return new Response("Not found", { status: 404 });
  return Response.json(task);
});

// ─── POST /api/tasks ─────────────────────────────────────────────────────────
// Creates a task, auto-routes it to the best team/agent, emits task.created event.

tasksRouter.post("/api/tasks", async (req, env) => {
  const body = await req.json<{
    kind: string;
    input: { summary: string; details?: string };
    createdByAgentId?: string | null;
    assignedAgentId?: string | null;
    preferredTeamId?: string | null;
  }>();

  if (!body.kind || !body.input?.summary) {
    return Response.json({ error: "kind and input.summary are required" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await run(
    env.DB,
    `INSERT INTO tasks (id, kind, status, created_by_agent_id, assigned_agent_id, input, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [
      id,
      body.kind,
      body.createdByAgentId ?? null,
      body.assignedAgentId ?? null,
      JSON.stringify(body.input),
      now,
      now,
    ],
  );

  // Auto-route unless caller already assigned an agent
  const route = body.assignedAgentId
    ? { agentId: body.assignedAgentId, teamId: body.preferredTeamId ?? null }
    : await routeTask(env.DB, body.kind, body.preferredTeamId);

  if (route.agentId || route.teamId) {
    await run(
      env.DB,
      "UPDATE tasks SET assigned_agent_id=?, team_id=?, updated_at=? WHERE id=?",
      [route.agentId, route.teamId, now, id],
    );
  }

  // Emit task.created event
  const eventId = crypto.randomUUID();
  await run(
    env.DB,
    `INSERT INTO events (id, kind, actor_id, target_kind, target_id, payload, session_id, created_at, updated_at)
     VALUES (?, 'task.created', ?, 'task', ?, ?, NULL, ?, ?)`,
    [
      eventId,
      body.createdByAgentId ?? null,
      id,
      JSON.stringify({
        taskKind: body.kind,
        assignedAgentId: route.agentId,
        teamId: route.teamId,
      }),
      now,
      now,
    ],
  );

  return Response.json(
    { id, status: "pending", assignedAgentId: route.agentId, teamId: route.teamId },
    { status: 201 },
  );
});

// ─── PATCH /api/tasks/:id/assign ─────────────────────────────────────────────
// Manual re-assignment of a task to a different agent or team.

tasksRouter.patch("/api/tasks/:id/assign", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });

  const task = await queryOne<{ id: string; assigned_agent_id: string | null; team_id: string | null }>(
    env.DB,
    "SELECT id, assigned_agent_id, team_id FROM tasks WHERE id = ?",
    [id],
  );
  if (!task) return new Response("Not found", { status: 404 });

  const body = await req.json<{ agentId?: string | null; teamId?: string | null }>();
  const now = new Date().toISOString();

  await run(
    env.DB,
    "UPDATE tasks SET assigned_agent_id=COALESCE(?,assigned_agent_id), team_id=COALESCE(?,team_id), updated_at=? WHERE id=?",
    [body.agentId ?? null, body.teamId ?? null, now, id],
  );

  // Emit assignment event
  const eventId = crypto.randomUUID();
  await run(
    env.DB,
    `INSERT INTO events (id, kind, actor_id, target_kind, target_id, payload, session_id, created_at, updated_at)
     VALUES (?, 'task.status_changed', NULL, 'task', ?, ?, NULL, ?, ?)`,
    [
      eventId,
      id,
      JSON.stringify({
        note: "manual re-assignment",
        before: { agentId: task.assigned_agent_id, teamId: task.team_id },
        after: { agentId: body.agentId ?? task.assigned_agent_id, teamId: body.teamId ?? task.team_id },
      }),
      now,
      now,
    ],
  );

  return Response.json({ ok: true });
});

// ─── PATCH /api/tasks/:id/status ─────────────────────────────────────────────

tasksRouter.patch("/api/tasks/:id/status", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });
  const { status } = await req.json<{ status: Task["status"] }>();
  const now = new Date().toISOString();
  await run(env.DB, "UPDATE tasks SET status=?, updated_at=? WHERE id=?", [status, now, id]);
  return Response.json({ ok: true });
});
