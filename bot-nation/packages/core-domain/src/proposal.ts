import type { WithMeta, ID, Timestamp } from "./common";
import type { RiskLevel } from "./policy";

export type ProposalStatus =
  | "draft"
  | "pending_approval"
  | "approved"
  | "rejected"
  | "applied"
  | "failed";

export type ProposalType =
  | "agent_update"
  | "team_update"
  | "policy_change"
  | "skill_install"
  | "skill_update"
  | "config_change";

/** The entity this proposal intends to modify. */
export interface ProposalTarget {
  entityKind: "agent" | "team" | "policy" | "tool";
  entityId: ID;
}

/** Who or what originated this proposal. */
export interface ProposalRequester {
  agentId: ID | null;
  teamId: ID | null;
  humanId: string | null;
}

/** Risk assessment attached to the proposal. */
export interface ProposalRisk {
  level: RiskLevel;
  affectsWallets: boolean;
  affectsDeployment: boolean;
  notes?: string;
}

/** A single before/after benchmark result used in evaluation. */
export interface ProposalBenchmark {
  name: string;
  before: number | string | null;
  after: number | string | null;
  unit?: string;
}

/**
 * Evaluation result produced by an inspector/reviewer agent.
 * `passed` is null until evaluation completes.
 */
export interface ProposalEval {
  passed: boolean | null;
  benchmarks: ProposalBenchmark[];
  evaluatedAt: Timestamp | null;
}

/**
 * The partial patch to apply to the target entity when the proposal is approved.
 * Shape is validated at apply-time against an explicit field allowlist.
 */
export type ProposalChangeSet = Record<string, unknown>;

export interface Proposal extends WithMeta {
  type: ProposalType;
  target: ProposalTarget;
  requester: ProposalRequester;
  title: string;
  summary: string;
  changeSet: ProposalChangeSet;
  risk: ProposalRisk;
  eval: ProposalEval;
  /** ID of the linked Approval record (created when proposal enters pending_approval). */
  approvalId: ID | null;
  status: ProposalStatus;
  /** Set when status transitions to "applied". */
  appliedAt: Timestamp | null;
}
