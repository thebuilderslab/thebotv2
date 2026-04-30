import { WithMeta, ID } from "./common";

export type TaskStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "approved"
  | "rejected"
  | "completed"
  | "failed";

export type TaskKind =
  | "improvement_proposal"
  | "code_change"
  | "config_change"
  | "wallet_simulation"
  | "content_generation"
  | "research"
  | "propstream_outbound_call"
  | "propstream_lead_score"
  | "other";

export interface TaskInput {
  summary: string;
  details?: string;
  relatedAgentIds?: ID[];
  relatedTeamIds?: ID[];
  relatedArtifactIds?: ID[];
}

export interface TaskOutput {
  summary?: string;
  artifactIds?: ID[];
  logUrl?: string;
}

export interface Task extends WithMeta {
  kind: TaskKind;
  status: TaskStatus;
  createdByAgentId: ID | null;
  assignedAgentId: ID | null;
  input: TaskInput;
  output?: TaskOutput;
  approvalId?: ID;
  scheduled_for?: string | null; // ISO 8601 timestamp for delayed execution
}