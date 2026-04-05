/**
 * Policy Enforcer
 *
 * Checks a proposal against the governance policy of its requester team.
 * Called from POST /api/proposals/:id/submit before creating an Approval.
 *
 * If the proposal has no requester_team_id, enforcement is skipped (allow).
 */

import { queryOne } from "../db/schema";

export type RiskLevel = "low" | "medium" | "high" | "critical";

const RISK_ORDER: RiskLevel[] = ["low", "medium", "high", "critical"];

function riskIndex(level: string): number {
  const idx = RISK_ORDER.indexOf(level as RiskLevel);
  return idx === -1 ? 0 : idx;
}

export interface PolicyCheckResult {
  allowed: boolean;
  reason?: string;
  /** If allowed and team has policies, the team's requiresHumanApproval value */
  requiresHumanApproval?: boolean;
}

interface TeamRow {
  id: string;
  policies: string; // JSON
}

interface TeamPolicy {
  maxRiskTier: RiskLevel;
  requiresHumanApproval: boolean;
  allowedCapabilities: string[];
  blockedCapabilities: string[];
}

/**
 * Check a proposal against the requester team's policy.
 *
 * @param db           D1 database binding
 * @param requesterTeamId  team ID from the proposal (may be null)
 * @param riskLevel    the proposal's evaluated risk level
 * @param changeSet    the proposal's changeSet (checked against blockedCapabilities)
 */
export async function checkProposalAgainstPolicy(
  db: D1Database,
  requesterTeamId: string | null,
  riskLevel: string,
  changeSet: Record<string, unknown>,
): Promise<PolicyCheckResult> {
  // No team context — skip enforcement, allow with human approval required
  if (!requesterTeamId) {
    return { allowed: true, requiresHumanApproval: true };
  }

  const team = await queryOne<TeamRow>(
    db,
    "SELECT id, policies FROM teams WHERE id = ?",
    [requesterTeamId],
  );

  if (!team) {
    // Team not found — fail safe: block and surface the error
    return { allowed: false, reason: `Requester team '${requesterTeamId}' not found` };
  }

  let policies: TeamPolicy;
  try {
    policies = JSON.parse(team.policies) as TeamPolicy;
  } catch {
    return { allowed: false, reason: "Failed to parse team policies — contact admin" };
  }

  // ── check maxRiskTier ────────────────────────────────────────────────────
  if (riskIndex(riskLevel) > riskIndex(policies.maxRiskTier)) {
    return {
      allowed: false,
      reason: `Proposal risk '${riskLevel}' exceeds team's maxRiskTier '${policies.maxRiskTier}'`,
    };
  }

  // ── check blockedCapabilities ────────────────────────────────────────────
  const blocked = policies.blockedCapabilities ?? [];
  if (blocked.length > 0) {
    const changeSetKeys = Object.keys(changeSet);
    const hit = changeSetKeys.find((k) => blocked.includes(k));
    if (hit) {
      return {
        allowed: false,
        reason: `changeSet field '${hit}' is blocked by team policy`,
      };
    }
  }

  return {
    allowed: true,
    requiresHumanApproval: policies.requiresHumanApproval,
  };
}
