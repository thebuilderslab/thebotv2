/**
 * Nation Map API — Phase 8A
 *
 * Returns a structured snapshot of the entire Bot Nation for the frontend map UI.
 * Includes teams, agents, live task counts, and active model assignments.
 */

import { AutoRouter, type IRequest } from "itty-router";
import type { Env } from "../index";
import { query } from "../db/schema";

export const nationRouter = AutoRouter<IRequest, [Env, ExecutionContext]>();

interface AgentRow {
  id: string;
  name: string;
  role: string;
  domain: string;
  description: string | null;
  capabilities: string | null;
  permissions: string | null;
  status: string;
}

interface TeamRow {
  id: string;
  name: string;
  domain: string;
  lead_agent_id: string | null;
  member_ids: string | null;
  policies: string | null;
}

interface TaskCountRow {
  assigned_agent_id: string;
  status: string;
  cnt: number;
}

nationRouter.get("/api/nation/map", async (_req, env) => {
  // Load all data in parallel
  const [teams, agents, taskCounts] = await Promise.all([
    query<TeamRow>(env.DB, "SELECT id, name, domain, lead_agent_id, member_ids, policies FROM teams ORDER BY name"),
    query<AgentRow>(env.DB, "SELECT id, name, role, domain, description, capabilities, permissions, status FROM agents WHERE status = 'active' ORDER BY name"),
    query<TaskCountRow>(
      env.DB,
      `SELECT assigned_agent_id, status, COUNT(*) AS cnt
       FROM tasks
       WHERE assigned_agent_id IS NOT NULL
         AND status IN ('pending','running','waiting_children')
       GROUP BY assigned_agent_id, status`,
    ),
  ]);

  // Build per-agent live task index
  const liveTaskMap: Record<string, { pending: number; running: number; waiting: number }> = {};
  for (const row of taskCounts) {
    if (!row.assigned_agent_id) continue;
    const agentId = row.assigned_agent_id;
    if (!liveTaskMap[agentId]) {
      liveTaskMap[agentId] = { pending: 0, running: 0, waiting: 0 };
    }
    const entry = liveTaskMap[agentId]!;
    if (row.status === "pending")           entry.pending += row.cnt;
    if (row.status === "running")           entry.running += row.cnt;
    if (row.status === "waiting_children")  entry.waiting += row.cnt;
  }

  // Build agent map for lookup
  const agentMap: Record<string, AgentRow> = {};
  for (const a of agents) agentMap[a.id] = a;

  // Compose team nodes
  const teamNodes = teams.map((team) => {
    const memberIds: string[] = team.member_ids ? (JSON.parse(team.member_ids) as string[]) : [];
    const members = memberIds.map((mid) => {
      const a = agentMap[mid];
      if (!a) return null;
      const live = liveTaskMap[mid] ?? { pending: 0, running: 0, waiting: 0 };
      return {
        id: a.id,
        name: a.name,
        role: a.role,
        domain: a.domain,
        description: a.description,
        capabilities: a.capabilities ? (JSON.parse(a.capabilities) as string[]) : [],
        permissions: a.permissions ? (JSON.parse(a.permissions) as Record<string, boolean>) : {},
        isLead: a.id === team.lead_agent_id,
        live,
      };
    }).filter(Boolean);

    const policies = team.policies ? (JSON.parse(team.policies) as Record<string, unknown>) : {};

    return {
      id: team.id,
      name: team.name,
      domain: team.domain,
      leadAgentId: team.lead_agent_id,
      policies,
      members,
    };
  });

  // Unassigned active agents (not in any team)
  const assignedIds = new Set(
    teams.flatMap((t) => (t.member_ids ? (JSON.parse(t.member_ids) as string[]) : [])),
  );
  const soloAgents = agents
    .filter((a) => !assignedIds.has(a.id))
    .map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      domain: a.domain,
      description: a.description,
      live: liveTaskMap[a.id] ?? { pending: 0, running: 0, waiting: 0 },
    }));

  return Response.json({
    generatedAt: new Date().toISOString(),
    teams: teamNodes,
    soloAgents,
    totals: {
      teams: teams.length,
      agents: agents.length,
      liveActive: taskCounts.reduce((s, r) => s + r.cnt, 0),
    },
  });
});
