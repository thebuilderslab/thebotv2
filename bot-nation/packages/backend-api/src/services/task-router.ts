/**
 * Task Router
 *
 * Given a task kind (and optional preferred team), returns the best-match
 * teamId and agentId to assign the task to.
 *
 * Called from POST /api/tasks and the cron dispatcher when a task has no
 * team assignment yet.
 */

import { queryOne } from "../db/schema";
import { KIND_TO_DOMAIN } from "@bot-nation/core-domain";

// KIND_TO_DOMAIN is imported from @bot-nation/core-domain (single source of truth).

export interface RouteResult {
  teamId: string | null;
  agentId: string | null;
}

interface TeamRow {
  id: string;
  lead_agent_id: string | null;
}

/**
 * Route a task to the most appropriate team and lead agent.
 *
 * Priority:
 * 1. preferredTeamId (if provided and the team exists in D1)
 * 2. Team whose domain matches the kind→domain map
 * 3. First active team found (fallback)
 * 4. Nation Supervisor (agent-supervisor-001), teamId null (last resort)
 */
export async function routeTask(
  db: D1Database,
  taskKind: string,
  preferredTeamId?: string | null,
): Promise<RouteResult> {
  // 1. Preferred team override
  if (preferredTeamId) {
    const team = await queryOne<TeamRow>(
      db,
      "SELECT id, lead_agent_id FROM teams WHERE id = ?",
      [preferredTeamId],
    );
    if (team) {
      return { teamId: team.id, agentId: team.lead_agent_id };
    }
  }

  // 2. Domain-matched team
  const targetDomain = KIND_TO_DOMAIN[taskKind];
  if (targetDomain) {
    const team = await queryOne<TeamRow>(
      db,
      "SELECT id, lead_agent_id FROM teams WHERE domain = ? LIMIT 1",
      [targetDomain],
    );
    if (team) {
      return { teamId: team.id, agentId: team.lead_agent_id };
    }
  }

  // 3. Any active team as fallback
  const anyTeam = await queryOne<TeamRow>(
    db,
    "SELECT id, lead_agent_id FROM teams LIMIT 1",
  );
  if (anyTeam) {
    return { teamId: anyTeam.id, agentId: anyTeam.lead_agent_id };
  }

  // 4. Nation Supervisor — always present after migration 0003
  return { teamId: null, agentId: "agent-supervisor-001" };
}
