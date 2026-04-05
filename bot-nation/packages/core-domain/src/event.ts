import type { WithMeta, ID } from "./common";

export type EventKind =
  // Agent lifecycle
  | "agent.created"
  | "agent.updated"
  | "agent.status_changed"
  // Team lifecycle
  | "team.created"
  | "team.updated"
  // Proposal lifecycle
  | "proposal.created"
  | "proposal.approved"
  | "proposal.rejected"
  | "proposal.applied"
  | "proposal.failed"
  // Approval lifecycle
  | "approval.created"
  | "approval.decided"
  // Task lifecycle
  | "task.created"
  | "task.status_changed"
  // Tool lifecycle
  | "tool.installed"
  | "tool.disabled"
  // Session lifecycle (Durable Objects)
  | "session.started"
  | "session.node_completed"
  | "session.completed"
  | "session.failed"
  // Agent messaging
  | "agent.message_sent";

export interface Event extends WithMeta {
  kind: EventKind;
  /** Agent or human ID that triggered this event. Null for system-generated events. */
  actorId: ID | null;
  /** The type of entity this event describes. */
  targetKind: "agent" | "team" | "proposal" | "approval" | "task" | "tool";
  targetId: ID;
  /**
   * Contextual data: before/after snapshots, decision rationale, error messages, etc.
   * Shape varies by EventKind.
   */
  payload: Record<string, unknown>;
  /** Groups all events produced by a single workflow run or human session. */
  sessionId: string | null;
}
