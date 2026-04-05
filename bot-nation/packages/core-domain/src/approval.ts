import { WithMeta, ID, Timestamp } from "./common";
import { RiskLevel } from "./policy";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export type ApprovalChannel = "telegram" | "dashboard" | "api";

export interface ApprovalBrief {
  title: string;
  summary: string;
  risk: RiskLevel;
  expectedBenefit: string;
  blastRadius: string;
}

export interface ApprovalDecision {
  status: ApprovalStatus;
  decidedByUserId: ID;
  decidedAt: Timestamp;
  channel: ApprovalChannel;
  rationale?: string;
}

export interface Approval extends WithMeta {
  taskId: ID;
  requestedByAgentId: ID | null;
  brief: ApprovalBrief;
  status: ApprovalStatus;
  decisions: ApprovalDecision[];
}