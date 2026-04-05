import type { WithMeta, ID } from "./common";

export type ToolKind = "mcp" | "api" | "script" | "browser" | "internal";

export type ToolStatus = "active" | "pending_review" | "disabled";

export interface Tool extends WithMeta {
  name: string;
  kind: ToolKind;
  status: ToolStatus;
  description?: string;
  /** URL, worker route, or other addressable endpoint for this tool. */
  endpoint?: string;
  /** MCP-style JSON Schema describing the tool's input parameters. */
  schema?: Record<string, unknown>;
  /** Agent that proposed installation of this tool (null if installed by a human). */
  installedByAgentId: ID | null;
  /** Approval record that authorized this tool's installation. */
  approvalId: ID | null;
}
