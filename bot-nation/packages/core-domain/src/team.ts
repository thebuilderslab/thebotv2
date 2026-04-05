import type { WithMeta, ID } from "./common";
import type { RiskLevel } from "./policy";

export type TeamDomain =
  | "governance"
  | "orchestration"
  | "knowledge"
  | "execution_finance"
  | "execution_product"
  | "execution_growth"
  | "execution_infra";

/** Governance rules that constrain what this team's agents may do. */
export interface TeamPolicy {
  maxRiskTier: RiskLevel;
  requiresHumanApproval: boolean;
  /** Tool IDs or capability names this team is explicitly permitted to use. */
  allowedCapabilities: string[];
  /** Tool IDs or capability names this team is explicitly blocked from using. */
  blockedCapabilities: string[];
}

export interface Team extends WithMeta {
  name: string;
  domain: TeamDomain;
  leadAgentId: ID | null;
  memberIds: ID[];
  /** Optional parent team ID for nested hierarchy (e.g. sub-team of governance). */
  parentTeamId: ID | null;
  policies: TeamPolicy;
  description?: string;
}