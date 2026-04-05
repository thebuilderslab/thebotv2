export type ID = string;

export type Timestamp = string; // ISO 8601

export interface WithMeta {
  id: ID;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}