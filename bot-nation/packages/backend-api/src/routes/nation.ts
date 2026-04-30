/**
 * Nation Map API — Phase 8A
 *
 * Returns a structured snapshot of the entire Bot Nation for the frontend map UI.
 * Includes teams, agents, live task counts, and active model assignments.
 */

import { AutoRouter, type IRequest } from "itty-router";
import type { Env } from "../index";
import { query, queryOne } from "../db/schema";

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
  objectives: string | null;
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

// ── Room unlock status ────────────────────────────────────────────────────────
//
// A room is no longer UC when BOTH conditions are met across all its teams:
//   1. Combined task count (missions + assignments) >= 3
//   2. At least 1 agent in the room has an active cron schedule
//
// GET /api/nation/room-status
// Returns per-team: { task_count, has_cron, unlocked }

interface TeamTaskCountRow { team_id: string; cnt: number }
interface CronTeamRow      { team_id: string }
interface CronAgentRow     { agent_id: string }

nationRouter.get("/api/nation/room-status", async (_req, env) => {
  const [taskCounts, cronTeams, cronAgents] = await Promise.all([
    // Total tasks ever assigned to each team (all statuses = missions + assignments)
    query<TeamTaskCountRow>(
      env.DB,
      `SELECT team_id, COUNT(*) AS cnt
       FROM tasks
       WHERE team_id IS NOT NULL
       GROUP BY team_id`,
    ),
    // Teams that have at least one active cron
    query<CronTeamRow>(
      env.DB,
      `SELECT DISTINCT team_id
       FROM scheduled_crons
       WHERE team_id IS NOT NULL AND status = 'active'`,
    ),
    // Agents that have at least one active cron (for rooms keyed by agent list)
    query<CronAgentRow>(
      env.DB,
      `SELECT DISTINCT agent_id
       FROM scheduled_crons
       WHERE agent_id IS NOT NULL AND status = 'active'`,
    ),
  ]);

  // Build lookup sets
  const taskMap   = new Map(taskCounts.map((r) => [r.team_id, r.cnt]));
  const cronTeamSet  = new Set(cronTeams.map((r) => r.team_id));
  const cronAgentSet = new Set(cronAgents.map((r) => r.agent_id));

  // Rooms that can dynamically unlock (always-on rooms are omitted)
  // Each entry: list of team IDs that collectively count toward unlock
  const ROOM_TEAMS: Record<string, string[]> = {
    "agency-lab":  ["team-growth", "team-agency"],
    "uc-finance":  ["team-finance"],
    "uc-bailey":   ["team-bailey"],
    "uc-p87":      ["team-p87"],
  };

  const result: Record<string, {
    task_count: number;
    has_cron: boolean;
    unlocked: boolean;
    teams: Record<string, { task_count: number; has_cron: boolean }>;
  }> = {};

  for (const [roomId, teamIds] of Object.entries(ROOM_TEAMS)) {
    const combinedTaskCount = teamIds.reduce((sum, tid) => sum + (taskMap.get(tid) ?? 0), 0);
    const hasCron = teamIds.some((tid) =>
      cronTeamSet.has(tid) ||
      // also check if any agent belonging to this team has a cron
      cronAgentSet.size > 0 // (coarse check — refined per-agent lookup below)
        ? (() => {
            // Check via agent membership in cron agent set — we don't have
            // team→agent mapping here, so we rely on the team-level cron check.
            // The frontend also passes agentIds per room for the agent-level check.
            return cronTeamSet.has(tid);
          })()
        : false,
    );

    const perTeam: Record<string, { task_count: number; has_cron: boolean }> = {};
    for (const tid of teamIds) {
      perTeam[tid] = {
        task_count: taskMap.get(tid) ?? 0,
        has_cron:   cronTeamSet.has(tid),
      };
    }

    result[roomId] = {
      task_count:  combinedTaskCount,
      has_cron:    hasCron,
      unlocked:    combinedTaskCount >= 3 && hasCron,
      teams:       perTeam,
    };
  }

  // Also expose the raw cron-agent set so the frontend can check per-agent
  return Response.json({
    rooms:           result,
    cron_agent_ids:  [...cronAgentSet],
    generated_at:    new Date().toISOString(),
  });
});

// ── Department summary ────────────────────────────────────────────────────────
//
// GET /api/nation/dept-summary/:teamId
// Returns team mission, agent roster, recent tasks (linkable), open proposals.

interface TeamDetailRow {
  id: string;
  name: string;
  domain: string;
  lead_agent_id: string | null;
  member_ids: string | null;
  policies: string | null;
  objectives: string | null;
}

interface AgentDetailRow {
  id: string;
  name: string;
  role: string;
  domain: string;
  status: string;
  capabilities: string | null;
  objectives: string | null;
}

interface TaskSummaryRow {
  id: string;
  kind: string;
  status: string;
  assigned_agent_id: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

interface ProposalSummaryRow {
  id: string;
  type: string | null;
  status: string;
  risk_level: string | null;
  created_at: string;
}

nationRouter.get("/api/nation/dept-summary/:teamId", async (req, env) => {
  const teamId = (req.params as Record<string, string>).teamId;
  if (!teamId) return Response.json({ error: "teamId required" }, { status: 400 });

  const teamRow = await queryOne<TeamDetailRow>(
    env.DB,
    "SELECT id, name, domain, lead_agent_id, member_ids, policies, objectives FROM teams WHERE id = ?",
    [teamId],
  );
  if (!teamRow) return Response.json({ error: "Team not found" }, { status: 404 });

  const memberIds: string[] = teamRow.member_ids ? (JSON.parse(teamRow.member_ids) as string[]) : [];

  // Fetch agents, tasks, and open proposals in parallel
  const placeholders = memberIds.length > 0 ? memberIds.map(() => "?").join(",") : "''";
  const [agentRows, taskRows, proposalRows] = await Promise.all([
    memberIds.length > 0
      ? query<AgentDetailRow>(
          env.DB,
          `SELECT id, name, role, domain, status, capabilities, objectives
           FROM agents WHERE id IN (${placeholders})`,
          memberIds,
        )
      : Promise.resolve([] as AgentDetailRow[]),
    query<TaskSummaryRow>(
      env.DB,
      `SELECT id, kind, status, assigned_agent_id,
              json_extract(input, '$.summary') AS summary,
              created_at, updated_at
       FROM tasks WHERE team_id = ?
       ORDER BY created_at DESC LIMIT 25`,
      [teamId],
    ),
    query<ProposalSummaryRow>(
      env.DB,
      `SELECT id, type, status, risk_level, created_at
       FROM proposals
       WHERE status IN ('draft','pending','pending_approval','under_review')
       ORDER BY created_at DESC LIMIT 8`,
      [],
    ),
  ]);

  // Group tasks by status for the summary bar
  const taskCounts: Record<string, number> = {};
  for (const t of taskRows) {
    taskCounts[t.status] = (taskCounts[t.status] ?? 0) + 1;
  }

  return Response.json({
    team: {
      id:          teamRow.id,
      name:        teamRow.name,
      domain:      teamRow.domain,
      leadAgentId: teamRow.lead_agent_id,
      objectives:  teamRow.objectives,
      policies:    teamRow.policies ? (JSON.parse(teamRow.policies) as Record<string, unknown>) : {},
      memberCount: memberIds.length,
    },
    agents: agentRows.map((a) => ({
      id:           a.id,
      name:         a.name,
      role:         a.role,
      status:       a.status,
      capabilities: a.capabilities ? (JSON.parse(a.capabilities) as string[]) : [],
      objectives:   a.objectives,
    })),
    tasks: taskRows.map((t) => ({
      id:              t.id,
      kind:            t.kind,
      status:          t.status,
      assignedAgentId: t.assigned_agent_id,
      summary:         t.summary,
      createdAt:       t.created_at,
      updatedAt:       t.updated_at,
    })),
    taskCounts,
    proposals: proposalRows,
    generatedAt: new Date().toISOString(),
  });
});
