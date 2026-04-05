import { AutoRouter, type IRequest } from "itty-router";
import type { Env } from "../index";
import { query, queryOne, run } from "../db/schema";

export const artifactsRouter = AutoRouter<IRequest, [Env, ExecutionContext]>();

// ─── GET /api/artifacts ──────────────────────────────────────────────────────
// Optional: ?taskId=<uuid>  ?kind=<kind>

artifactsRouter.get("/api/artifacts", async (req, env) => {
  const rawTaskId = req.query["taskId"];
  const rawKind = req.query["kind"];
  const taskId = Array.isArray(rawTaskId) ? rawTaskId[0] : rawTaskId;
  const kind = Array.isArray(rawKind) ? rawKind[0] : rawKind;

  const conditions: string[] = [];
  const params: string[] = [];

  if (taskId) { conditions.push("task_id = ?"); params.push(taskId); }
  if (kind)   { conditions.push("kind = ?");    params.push(kind); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await query(env.DB,
    `SELECT * FROM artifacts ${where} ORDER BY created_at DESC`, params);
  return Response.json(rows);
});

// ─── GET /api/artifacts/:id ──────────────────────────────────────────────────

artifactsRouter.get("/api/artifacts/:id", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });
  const row = await queryOne(env.DB, "SELECT * FROM artifacts WHERE id = ?", [id]);
  if (!row) return new Response("Not found", { status: 404 });
  return Response.json(row);
});

// ─── POST /api/artifacts ─────────────────────────────────────────────────────

artifactsRouter.post("/api/artifacts", async (req, env) => {
  const body = await req.json<{
    kind: string;
    name: string;
    url?: string;
    content?: string;
    taskId?: string | null;
    relatedAgentIds?: string[];
  }>();

  if (!body.kind || !body.name) {
    return Response.json({ error: "kind and name are required" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await run(env.DB,
    `INSERT INTO artifacts (id, kind, name, url, content, task_id, related_agent_ids, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      body.kind,
      body.name,
      body.url ?? "",
      body.content ?? null,
      body.taskId ?? null,
      JSON.stringify(body.relatedAgentIds ?? []),
      now,
      now,
    ],
  );

  return Response.json({ id }, { status: 201 });
});

// ─── DELETE /api/artifacts/:id ───────────────────────────────────────────────
// Soft-delete: preserve audit trail, mark name as [deleted].

artifactsRouter.delete("/api/artifacts/:id", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });
  const existing = await queryOne<{ id: string }>(env.DB,
    "SELECT id FROM artifacts WHERE id = ?", [id]);
  if (!existing) return new Response("Not found", { status: 404 });
  const now = new Date().toISOString();
  await run(env.DB,
    "UPDATE artifacts SET name='[deleted]', kind='other', updated_at=? WHERE id=?",
    [now, id]);
  return Response.json({ ok: true });
});
