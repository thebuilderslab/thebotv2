import { AutoRouter, type IRequest } from "itty-router";
import type { Env } from "../index";
import { query, queryOne, run } from "../db/schema";
import type { Team } from "@bot-nation/core-domain";

export const teamsRouter = AutoRouter<IRequest, [Env, ExecutionContext]>();

teamsRouter.get("/api/teams", async (_req, env) => {
  const rows = await query<Team>(env.DB, "SELECT * FROM teams ORDER BY created_at DESC");
  return Response.json(rows);
});

teamsRouter.get("/api/teams/:id", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });
  const team = await queryOne<Team>(env.DB, "SELECT * FROM teams WHERE id = ?", [id]);
  if (!team) return new Response("Not found", { status: 404 });
  return Response.json(team);
});

teamsRouter.post("/api/teams", async (req, env) => {
  const body = await req.json<Omit<Team, "id" | "createdAt" | "updatedAt">>();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const defaultPolicies = body.policies ?? {
    maxRiskTier: "low" as const,
    requiresHumanApproval: true,
    allowedCapabilities: [],
    blockedCapabilities: [],
  };
  await run(
    env.DB,
    `INSERT INTO teams (id, name, domain, lead_agent_id, member_ids, parent_team_id, policies, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      body.name,
      body.domain,
      body.leadAgentId ?? null,
      JSON.stringify(body.memberIds ?? []),
      body.parentTeamId ?? null,
      JSON.stringify(defaultPolicies),
      body.description ?? null,
      now,
      now,
    ]
  );
  return Response.json({ id }, { status: 201 });
});