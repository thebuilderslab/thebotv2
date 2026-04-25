import { WithMeta, ID } from "./common";

export type ArtifactKind =
  | "code_diff"
  | "config_patch"
  | "test_report"
  | "simulation_report"
  | "design_doc"
  | "log"
  | "other";

export interface Artifact extends WithMeta {
  kind: ArtifactKind;
  name: string;
  url: string;
  taskId: ID | null;
  relatedAgentIds?: ID[];
}