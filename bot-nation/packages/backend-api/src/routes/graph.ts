/**
 * Workspace Graph API
 *
 * Returns a snapshot of all entities and their relationships as a node/edge
 * graph suitable for force-directed rendering in the frontend.
 *
 * Queries agents, teams, tasks (last 50), and active tools.
 * Edges are derived from FK relationships in D1.
 */

import type { IRequest } from "itty-router";
import type { Env } from "../index";
import { query } from "../db/schema";

interface GraphNode {
  id: string;
  kind: "agent" | "team" | "task" | "tool";
  label: string;
  status?: string;
  domain?: string;
  toolKind?: string;
}

interface GraphEdge {
  source: string;
  target: string;
  relation: "member_of" | "assigned" | "created" | "uses";
}

interface AgentRow { id: string; name: string; status: string; team_id: string | null; }
interface TeamRow  { id: string; name: string; domain: string; }
interface TaskRow  { id: string; kind: string; status: string; team_id: string | null; assigned_agent_id: string | null; created_by_agent_id: string | null; }
interface ToolRow  { id: string; name: string; kind: string; status: string; }

export async function graphHandler(
  _req: IRequest,
  env: Env,
): Promise<Response> {
  const [agents, teams, tasks, tools] = await Promise.all([
    query<AgentRow>(env.DB, "SELECT id, name, status, team_id FROM agents"),
    query<TeamRow>(env.DB, "SELECT id, name, domain FROM teams"),
    query<TaskRow>(env.DB,
      "SELECT id, kind, status, team_id, assigned_agent_id, created_by_agent_id FROM tasks ORDER BY created_at DESC LIMIT 50"),
    query<ToolRow>(env.DB, "SELECT id, name, kind, status FROM tools WHERE status = 'active'"),
  ]);

  const nodes: GraphNode[] = [
    ...agents.map((a) => ({ id: a.id, kind: "agent" as const, label: a.name, status: a.status })),
    ...teams.map((t)  => ({ id: t.id, kind: "team"  as const, label: t.name, domain: t.domain })),
    ...tasks.map((t)  => ({ id: t.id, kind: "task"  as const, label: t.kind, status: t.status })),
    ...tools.map((t)  => ({ id: t.id, kind: "tool"  as const, label: t.name, toolKind: t.kind })),
  ];

  const edges: GraphEdge[] = [];

  // agent → team (member_of)
  for (const a of agents) {
    if (a.team_id) edges.push({ source: a.id, target: a.team_id, relation: "member_of" });
  }

  // task → agent (assigned)
  for (const t of tasks) {
    if (t.assigned_agent_id) edges.push({ source: t.assigned_agent_id, target: t.id, relation: "assigned" });
    if (t.team_id)           edges.push({ source: t.team_id,           target: t.id, relation: "assigned" });
    if (t.created_by_agent_id) edges.push({ source: t.created_by_agent_id, target: t.id, relation: "created" });
  }

  return Response.json({ nodes, edges });
}
