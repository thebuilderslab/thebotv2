import type { WithMeta, ID } from "./common";

export type SessionStatus = "idle" | "running" | "streaming" | "completed" | "failed";

export interface AgentSession extends WithMeta {
  agentId: ID;
  taskId: ID | null;
  graphId: ID | null;
  status: SessionStatus;
  wsConnected: boolean;
  startedAt: string;
  completedAt: string | null;
}
