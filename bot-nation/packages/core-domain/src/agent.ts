import type { WithMeta, ID } from "./common";

export type AgentRole =
  | "governor"
  | "team_lead"
  | "worker"
  | "inspector"
  | "finance_specialist"
  | "infra_specialist"
  | "researcher"
  | "designer"
  | "growth";

export type AgentDomain =
  | "governance"
  | "orchestration"
  | "code_safety"
  | "product"
  | "growth"
  | "infra"
  | "blockchain_sim"
  | "other";

/** Lifecycle status of an agent. Replaces the old `active: boolean`. */
export type AgentStatus = "active" | "paused" | "retired";

/** Controls what high-risk operations this agent is allowed to trigger. */
export interface AgentPermissions {
  canWriteCode: boolean;
  canModifyAgents: boolean;
  canTouchWallets: boolean;
  canAutoDeploy: boolean;
}

export interface AgentTrait {
  name: string;
  value: number;
}

export interface AgentCapability {
  toolId: ID;
  scope: "read" | "write" | "execute" | "admin";
}

export interface Agent extends WithMeta {
  name: string;
  role: AgentRole;
  domain: AgentDomain;
  teamId: ID | null;
  status: AgentStatus;
  permissions: AgentPermissions;
  traits: AgentTrait[];
  capabilities: AgentCapability[];
  description?: string;
}