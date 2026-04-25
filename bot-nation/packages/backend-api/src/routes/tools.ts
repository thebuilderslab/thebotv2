import { AutoRouter, type IRequest } from "itty-router";
import type { Env } from "../index";
import { query, queryOne, run } from "../db/schema";

export const toolsRouter = AutoRouter<IRequest, [Env, ExecutionContext]>();

// ─── GET /api/tools ──────────────────────────────────────────────────────────
// Optional: ?status=active|pending_review|disabled

toolsRouter.get("/api/tools", async (req, env) => {
  const rawStatus = req.query["status"];
  const status = Array.isArray(rawStatus) ? rawStatus[0] : rawStatus;
  const rows = status
    ? await query(env.DB, "SELECT * FROM tools WHERE status = ? ORDER BY created_at DESC", [status])
    : await query(env.DB, "SELECT * FROM tools ORDER BY created_at DESC");
  return Response.json(rows);
});

// ─── GET /api/tools/:id ──────────────────────────────────────────────────────

toolsRouter.get("/api/tools/:id", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });
  const tool = await queryOne(env.DB, "SELECT * FROM tools WHERE id = ?", [id]);
  if (!tool) return new Response("Not found", { status: 404 });
  return Response.json(tool);
});

// ─── POST /api/tools ─────────────────────────────────────────────────────────
// New tools start as "pending_review".

toolsRouter.post("/api/tools", async (req, env) => {
  const body = await req.json<{
    name: string;
    kind: "mcp" | "api" | "script" | "browser" | "internal";
    description?: string;
    endpoint?: string;
    schema?: Record<string, unknown>;
    installedByAgentId?: string | null;
    approvalId?: string | null;
  }>();

  if (!body.name || !body.kind) {
    return Response.json({ error: "name and kind are required" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await run(env.DB,
    `INSERT INTO tools (id, name, kind, status, description, endpoint, schema, installed_by_agent_id, approval_id, created_at, updated_at)
     VALUES (?, ?, ?, 'pending_review', ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      body.name,
      body.kind,
      body.description ?? null,
      body.endpoint ?? null,
      body.schema !== undefined ? JSON.stringify(body.schema) : null,
      body.installedByAgentId ?? null,
      body.approvalId ?? null,
      now,
      now,
    ],
  );

  return Response.json({ id, status: "pending_review" }, { status: 201 });
});

// ─── PATCH /api/tools/:id/status ─────────────────────────────────────────────

toolsRouter.patch("/api/tools/:id/status", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });
  const body = await req.json<{ status: "active" | "disabled" | "pending_review" }>();
  if (!["active", "disabled", "pending_review"].includes(body.status)) {
    return Response.json({ error: "Invalid status" }, { status: 400 });
  }
  const now = new Date().toISOString();
  await run(env.DB,
    "UPDATE tools SET status=?, updated_at=? WHERE id=?", [body.status, now, id]);
  return Response.json({ ok: true });
});
