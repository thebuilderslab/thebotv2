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
  const agent = await queryOne<Agent>(env.DB, "SELECT * FROM agents WHERE id = ?", [req.params.id]);
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
      req.params["id"],
    ]
  );
  return Response.json({ ok: true });
});