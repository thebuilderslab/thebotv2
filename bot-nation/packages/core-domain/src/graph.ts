import type { WithMeta, ID } from "./common";

export type GraphNodeKind = "llm_call" | "tool_call" | "spawn_agent" | "condition" | "end";
export type GraphEdgeCondition = "always" | "on_success" | "on_failure";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label?: string;
  /** For llm_call nodes: system/user prompt. Use {{prev}} to inject previous node output. */
  prompt?: string;
  /** For tool_call nodes: the tool name to invoke. */
  toolName?: string;
  /** For spawn_agent nodes: target agent ID to delegate to. */
  targetAgentId?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  condition: GraphEdgeCondition;
}

export interface AgentGraphDefinition {
  nodes: GraphNode[];
  edges: GraphEdge[];
  startNode: string;
}

export interface AgentGraph extends WithMeta {
  agentId: ID;
  name: string;
  description?: string;
  definition: AgentGraphDefinition;
  isDefault: boolean;
}
