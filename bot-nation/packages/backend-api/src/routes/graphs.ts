/**
 * Agent Graphs routes — Phase 6
 * CRUD for LangGraph-style execution graph definitions.
 */

import { AutoRouter, type IRequest } from "itty-router";
import type { Env } from "../index";
import { query, queryOne, run } from "../db/schema";

export const graphsRouter = AutoRouter<IRequest, [Env, ExecutionContext]>();

// ─── GET /api/graphs ──────────────────────────────────────────────────────────

graphsRouter.get("/api/graphs", async (_req, env) => {
  const rows = await query(
    env.DB,
    "SELECT * FROM agent_graphs ORDER BY is_default DESC, created_at DESC",
    [],
  );
  return Response.json(rows);
});

// ─── GET /api/graphs/agent/:agentId ──────────────────────────────────────────

graphsRouter.get("/api/graphs/agent/:agentId", async (req, env) => {
  const agentId = req.params["agentId"];
  if (!agentId) return new Response("Bad Request", { status: 400 });
  const rows = await query(
    env.DB,
    "SELECT * FROM agent_graphs WHERE agent_id = ? ORDER BY is_default DESC, created_at DESC",
    [agentId],
  );
  return Response.json(rows);
});

// ─── GET /api/graphs/:id ─────────────────────────────────────────────────────

graphsRouter.get("/api/graphs/:id", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });
  const row = await queryOne(env.DB, "SELECT * FROM agent_graphs WHERE id = ?", [id]);
  if (!row) return new Response("Not found", { status: 404 });
  return Response.json(row);
});

// ─── POST /api/graphs ─────────────────────────────────────────────────────────

graphsRouter.post("/api/graphs", async (req, env) => {
  const body = await req.json<{
    agentId: string;
    name: string;
    description?: string;
    definition: unknown;
    isDefault?: boolean;
  }>();

  if (!body.agentId || !body.name || !body.definition) {
    return Response.json({ error: "agentId, name, and definition are required" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  if (body.isDefault) {
    await run(env.DB, "UPDATE agent_graphs SET is_default=0 WHERE agent_id=?", [body.agentId]);
  }

  await run(
    env.DB,
    `INSERT INTO agent_graphs (id, agent_id, name, description, definition, is_default, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      body.agentId,
      body.name,
      body.description ?? null,
      JSON.stringify(body.definition),
      body.isDefault ? 1 : 0,
      now,
      now,
    ],
  );

  return Response.json({ id }, { status: 201 });
});

// ─── PATCH /api/graphs/:id ────────────────────────────────────────────────────

graphsRouter.patch("/api/graphs/:id", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });

  const existing = await queryOne<{ agent_id: string }>(
    env.DB, "SELECT agent_id FROM agent_graphs WHERE id = ?", [id],
  );
  if (!existing) return new Response("Not found", { status: 404 });

  const body = await req.json<{ name?: string; description?: string; definition?: unknown; isDefault?: boolean }>();
  const now = new Date().toISOString();

  if (body.isDefault) {
    await run(env.DB, "UPDATE agent_graphs SET is_default=0 WHERE agent_id=?", [existing.agent_id]);
  }

  await run(
    env.DB,
    `UPDATE agent_graphs SET
       name=COALESCE(?,name),
       description=COALESCE(?,description),
       definition=COALESCE(?,definition),
       is_default=COALESCE(?,is_default),
       updated_at=?
     WHERE id=?`,
    [
      body.name ?? null,
      body.description ?? null,
      body.definition ? JSON.stringify(body.definition) : null,
      body.isDefault !== undefined ? (body.isDefault ? 1 : 0) : null,
      now,
      id,
    ],
  );

  return Response.json({ ok: true });
});

// ─── DELETE /api/graphs/:id ───────────────────────────────────────────────────

graphsRouter.delete("/api/graphs/:id", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });
  await run(env.DB, "DELETE FROM agent_graphs WHERE id = ?", [id]);
  return Response.json({ ok: true });
});
