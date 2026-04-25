import { AutoRouter, type IRequest } from "itty-router";
import type { Env } from "../index";
import { query, queryOne, run } from "../db/schema";
import type { Agent } from "@bot-nation/core-domain";

export const agentsRouter = AutoRouter<IRequest, [Env, ExecutionContext]>();

agentsRouter.get("/api/agents", async (_req, env) => {
  const rows = await query<Agent>(env.DB, "SELECT * FROM agents ORDER BY created_at DESC");
  return Response.json(rows);
});

agentsRouter.get("/api/agents/:id", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });
  const agent = await queryOne<Agent>(env.DB, "SELECT * FROM agents WHERE id = ?", [id]);
  if (!agent) return new Response("Not found", { status: 404 });
  return Response.json(agent);
});

agentsRouter.post("/api/agents", async (req, env) => {
  const body = await req.json<Omit<Agent, "id" | "createdAt" | "updatedAt">>();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await run(
    env.DB,
    `INSERT INTO agents (id, name, role, domain, team_id, status, permissions, traits, capabilities, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      body.name,
      body.role,
      body.domain,
      body.teamId ?? null,
      body.status ?? "active",
      JSON.stringify(body.permissions ?? { canWriteCode: false, canModifyAgents: false, canTouchWallets: false, canAutoDeploy: false }),
      JSON.stringify(body.traits ?? []),
      JSON.stringify(body.capabilities ?? []),
      body.description ?? null,
      now,
      now,
    ]
  );
  return Response.json({ id }, { status: 201 });
});

agentsRouter.patch("/api/agents/:id", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });
  const body = await req.json<Partial<Agent>>();
  const now = new Date().toISOString();
  await run(
    env.DB,
    `UPDATE agents SET
       name=COALESCE(?,name),
       role=COALESCE(?,role),
       domain=COALESCE(?,domain),
       status=COALESCE(?,status),
       permissions=COALESCE(?,permissions),
       description=COALESCE(?,description),
       updated_at=?
     WHERE id=?`,
    [
      body.name ?? null,
      body.role ?? null,
      body.domain ?? null,
      body.status ?? null,
      body.permissions !== undefined ? JSON.stringify(body.permissions) : null,
      body.description ?? null,
      now,
      id,
    ]
  );
  return Response.json({ ok: true });
});

// ─── Agent Notes (scratchpad) ─────────────────────────────────────────────────
// Must be registered BEFORE /api/agents/:id to avoid shadowing.

agentsRouter.get("/api/agents/:id/notes", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });
  const rows = await query(env.DB,
    "SELECT * FROM agent_notes WHERE agent_id = ? ORDER BY updated_at DESC", [id]);
  return Response.json(rows);
});

agentsRouter.get("/api/agents/:id/notes/:key", async (req, env) => {
  const id = req.params["id"];
  const key = req.params["key"];
  if (!id || !key) return new Response("Bad Request", { status: 400 });
  const note = await queryOne(env.DB,
    "SELECT * FROM agent_notes WHERE agent_id = ? AND key = ?", [id, key]);
  if (!note) return new Response("Not found", { status: 404 });
  return Response.json(note);
});

agentsRouter.put("/api/agents/:id/notes/:key", async (req, env) => {
  const id = req.params["id"];
  const key = req.params["key"];
  if (!id || !key) return new Response("Bad Request", { status: 400 });
  const body = await req.json<{ value: string }>();
  if (body.value === undefined) {
    return Response.json({ error: "value is required" }, { status: 400 });
  }
  const now = new Date().toISOString();
  const noteId = crypto.randomUUID();
  await run(env.DB,
    `INSERT INTO agent_notes (id, agent_id, key, value, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [noteId, id, key, body.value, now, now]);
  return Response.json({ ok: true });
});

agentsRouter.delete("/api/agents/:id/notes/:key", async (req, env) => {
  const id = req.params["id"];
  const key = req.params["key"];
  if (!id || !key) return new Response("Bad Request", { status: 400 });
  await run(env.DB,
    "DELETE FROM agent_notes WHERE agent_id = ? AND key = ?", [id, key]);
  return Response.json({ ok: true });
});