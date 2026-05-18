/**
 * Canonical task-routing table.
 *
 * Single source of truth for `kind → {domain, teamId, agentId}` routing.
 * Both routes/telegram.ts (hot webhook path) and services/task-router.ts
 * (D1-backed dynamic router) import from here.
 *
 * Adding a new task kind: add one entry here. Both call sites pick it up.
 *
 * Derived views (`KIND_TO_DOMAIN`, `TASK_KIND_ROUTING`) are exported for
 * backwards-compatible imports — call sites can keep their existing usage.
 */

import type { TeamDomain } from "./team";

export interface TaskRouting {
  domain: TeamDomain;
  teamId: string;
  agentId: string;
}

export const TASK_ROUTING: Record<string, TaskRouting> = {
  // Bot Nation core
  research:             { domain: "knowledge",         teamId: "team-research", agentId: "agent-research-lead" },
  deep_research:        { domain: "knowledge",         teamId: "team-research", agentId: "agent-research-lead" },
  content_generation:   { domain: "execution_growth",  teamId: "team-growth",   agentId: "agent-growth-lead" },
  code_change:          { domain: "execution_product", teamId: "team-build",    agentId: "agent-build-lead" },
  improvement_proposal: { domain: "governance",        teamId: "team-build",    agentId: "agent-build-lead" },
  config_change:        { domain: "execution_infra",   teamId: "team-infra",    agentId: "agent-infra-lead" },
  wallet_simulation:    { domain: "execution_finance", teamId: "team-finance",  agentId: "agent-finance-lead" },
  // projecT87 DeFi
  defi_plan:            { domain: "execution_finance", teamId: "team-p87",      agentId: "agent-p87-planner" },
  defi_risk_check:      { domain: "execution_finance", teamId: "team-p87",      agentId: "agent-p87-risk" },
  defi_health_monitor:  { domain: "execution_finance", teamId: "team-p87",      agentId: "agent-p87-nurse" },
  defi_report:          { domain: "execution_finance", teamId: "team-p87",      agentId: "agent-p87-nurse" },
  // The Agency sales
  market_research:      { domain: "execution_growth",  teamId: "team-agency",   agentId: "agent-agency-growthops" },
  campaign_generation:  { domain: "execution_growth",  teamId: "team-agency",   agentId: "agent-agency-growthops" },
  lead_qualification:   { domain: "execution_growth",  teamId: "team-agency",   agentId: "agent-agency-pipelineops" },
  crm_hygiene:          { domain: "execution_growth",  teamId: "team-agency",   agentId: "agent-agency-revops" },
  // Intel — repo + link review
  intel_review:         { domain: "knowledge",         teamId: "team-intel",    agentId: "agent-intel-lead" },
};

// Derived views (backwards-compatible)

export const KIND_TO_DOMAIN: Record<string, TeamDomain> = Object.fromEntries(
  Object.entries(TASK_ROUTING).map(([kind, r]) => [kind, r.domain]),
);

export const TASK_KIND_ROUTING: Record<string, { teamId: string; agentId: string }> = Object.fromEntries(
  Object.entries(TASK_ROUTING).map(([kind, r]) => [kind, { teamId: r.teamId, agentId: r.agentId }]),
);
