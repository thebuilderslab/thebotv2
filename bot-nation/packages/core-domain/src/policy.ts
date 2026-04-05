import { WithMeta } from "./common";
import { TaskKind } from "./task";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ChangePolicyRule {
  name: string;
  appliesToKinds: TaskKind[];
  maxRisk: RiskLevel;
  requiresHumanApproval: boolean;
  minApproverRole: "team_lead" | "governor";
  notes?: string;
}

export interface Policy extends WithMeta {
  name: string;
  description?: string;
  rules: ChangePolicyRule[];
}