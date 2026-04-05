import { AutoRouter, type IRequest } from "itty-router";
import type { Env } from "../index";
import { query, queryOne, run } from "../db/schema";
import type { Task } from "@bot-nation/core-domain";

export const tasksRouter = AutoRouter<IRequest, [Env, ExecutionContext]>();

tasksRouter.get("/api/tasks", async (_req, env) => {
  const rows = await query<Task>(env.DB, "SELECT * FROM tasks ORDER BY created_at DESC");
  return Response.json(rows);
});

tasksRouter.get("/api/tasks/:id", async (req, env) => {
  const task = await queryOne<Task>(env.DB, "SELECT * FROM tasks WHERE id = ?", [req.params.id]);
  if (!task) return new Response("Not found", { status: 404 });
  return Response.json(task);
});

tasksRouter.post("/api/tasks", async (req, env) => {
  const body = await req.json<Omit<Task, "id" | "createdAt" | "updatedAt" | "status">>();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await run(
    env.DB,
    `INSERT INTO tasks (id, kind, status, created_by_agent_id, assigned_agent_id, input, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [id, body.kind, body.createdByAgentId ?? null,
     body.assignedAgentId ?? null, JSON.stringify(body.input), now, now]
  );
  return Response.json({ id }, { status: 201 });
});

tasksRouter.patch("/api/tasks/:id/status", async (req, env) => {
  const { status } = await req.json<{ status: Task["status"] }>();
  const now = new Date().toISOString();
  await run(env.DB, "UPDATE tasks SET status=?, updated_at=? WHERE id=?",
    [status, now, req.params.id]);
  return Response.json({ ok: true });
});