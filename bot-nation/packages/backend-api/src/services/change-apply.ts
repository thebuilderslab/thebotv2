/**
 * apply-change service
 *
 * When a Proposal is approved, this service:
 *   1. Loads the proposal and validates its changeSet against a per-entity field allowlist
 *   2. Applies the patch to the target entity in D1
 *   3. Marks the proposal as "applied" (or "failed")
 *   4. Emits an Event to the audit log
 *
 * This is the fix for the old broken pattern where approval updated status columns
 * but never actually mutated the target entity.
 */

import { queryOne, run } from "../db/schema";

// ─── field allowlists ────────────────────────────────────────────────────────
// Only fields listed here may appear in a changeSet for that entity kind.
// This is the enforcement point — anything outside the list is rejected.

const AGENT_ALLOWED_FIELDS = new Set([
  "name",
  "role",
  "domain",
  "teamId",
  "status",
  "description",
  "permissions",
  "traits",
  "capabilities",
]);

const TEAM_ALLOWED_FIELDS = new Set([
  "name",
  "domain",
  "leadAgentId",
  "memberIds",
  "parentTeamId",
  "policies",
  "description",
]);

// ─── result type ─────────────────────────────────────────────────────────────

export type ApplyChangeResult =
  | { ok: true; entityId: string; appliedFields: string[] }
  | { ok: false; error: string };

// ─── main entry point ────────────────────────────────────────────────────────

/**
 * Find the proposal linked to `approvalId`, validate its changeSet, apply it,
 * and emit an audit event.
 *
 * Safe to call even if no proposal is linked to the approval — in that case it
 * returns ok:true with an empty appliedFields array (nothing to do).
 */
export async function applyChangeForApproval(
  db: D1Database,
  approvalId: string,
  actorId: string | null,
  sessionId: string | null,
): Promise<ApplyChangeResult> {
  // Look up the proposal linked to this approval
  const proposal = await queryOne<{
    id: string;
    target_entity_kind: string;
    target_entity_id: string;
    change_set: string;
    status: string;
  }>(db, "SELECT id, target_entity_kind, target_entity_id, change_set, status FROM proposals WHERE approval_id = ?", [approvalId]);

  // No linked proposal — nothing to apply (e.g. intake approvals)
  if (!proposal) {
    return { ok: true, entityId: approvalId, appliedFields: [] };
  }

  // Mark proposal as approved so applyChangeFromProposal can proceed
  const now = new Date().toISOString();
  await run(db, "UPDATE proposals SET status='approved', updated_at=? WHERE id=?", [now, proposal.id]);

  return applyChangeFromProposal(db, proposal.id, actorId, sessionId);
}

/**
 * Apply a proposal's changeSet directly by proposal ID.
 * The proposal must already have status = "approved".
 */
export async function applyChangeFromProposal(
  db: D1Database,
  proposalId: string,
  actorId: string | null,
  sessionId: string | null,
): Promise<ApplyChangeResult> {
  const proposal = await queryOne<{
    id: string;
    target_entity_kind: string;
    target_entity_id: string;
    change_set: string;
    status: string;
  }>(db, "SELECT id, target_entity_kind, target_entity_id, change_set, status FROM proposals WHERE id = ?", [proposalId]);

  if (!proposal) return { ok: false, error: "Proposal not found" };
  if (proposal.status !== "approved") {
    return { ok: false, error: `Proposal status is '${proposal.status}', expected 'approved'` };
  }

  const changeSet: Record<string, unknown> = JSON.parse(proposal.change_set);
  const kind = proposal.target_entity_kind;
  const entityId = proposal.target_entity_id;

  // ── validate changeSet keys against allowlist ──────────────────────────────
  const allowlist =
    kind === "agent" ? AGENT_ALLOWED_FIELDS
    : kind === "team" ? TEAM_ALLOWED_FIELDS
    : null;

  if (!allowlist) {
    return markFailed(db, proposalId, actorId, sessionId, `Unsupported entity kind: ${kind}`);
  }

  const keys = Object.keys(changeSet);
  if (keys.length === 0) {
    return markFailed(db, proposalId, actorId, sessionId, "changeSet is empty — nothing to apply");
  }

  const forbidden = keys.filter((k) => !allowlist.has(k));
  if (forbidden.length > 0) {
    return markFailed(
      db, proposalId, actorId, sessionId,
      `Forbidden fields in changeSet for '${kind}': ${forbidden.join(", ")}`,
    );
  }

  // ── apply patch to target entity ───────────────────────────────────────────
  const patchError =
    kind === "agent"
      ? await applyAgentPatch(db, entityId, changeSet)
      : await applyTeamPatch(db, entityId, changeSet);

  if (patchError) {
    return markFailed(db, proposalId, actorId, sessionId, patchError);
  }

  // ── mark proposal applied ──────────────────────────────────────────────────
  const now = new Date().toISOString();
  await run(
    db,
    "UPDATE proposals SET status='applied', applied_at=?, updated_at=? WHERE id=?",
    [now, now, proposalId],
  );

  // ── emit audit event ───────────────────────────────────────────────────────
  await emitEvent(db, "proposal.applied", actorId, "proposal", proposalId, {
    entityKind: kind,
    entityId,
    appliedFields: keys,
    changeSet,
  }, sessionId);

  return { ok: true, entityId, appliedFields: keys };
}

// ─── entity patchers ─────────────────────────────────────────────────────────

async function applyAgentPatch(
  db: D1Database,
  agentId: string,
  patch: Record<string, unknown>,
): Promise<string | null> {
  const exists = await queryOne<{ id: string }>(db, "SELECT id FROM agents WHERE id = ?", [agentId]);
  if (!exists) return `Agent not found: ${agentId}`;

  const now = new Date().toISOString();
  const setClauses: string[] = [];
  const params: (string | number | null)[] = [];

  // camelCase changeSet key → snake_case D1 column
  const scalarMap: Record<string, string> = {
    name: "name",
    role: "role",
    domain: "domain",
    teamId: "team_id",
    status: "status",
    description: "description",
  };
  const jsonColumns = new Set(["permissions", "traits", "capabilities"]);

  for (const [key, value] of Object.entries(patch)) {
    if (jsonColumns.has(key)) {
      setClauses.push(`${key} = ?`);
      params.push(JSON.stringify(value));
    } else if (scalarMap[key]) {
      setClauses.push(`${scalarMap[key]} = ?`);
      params.push(value as string | null);
    }
  }

  if (setClauses.length === 0) return "No mappable fields in changeSet for agent";

  setClauses.push("updated_at = ?");
  params.push(now, agentId);

  await run(db, `UPDATE agents SET ${setClauses.join(", ")} WHERE id = ?`, params);
  return null;
}

async function applyTeamPatch(
  db: D1Database,
  teamId: string,
  patch: Record<string, unknown>,
): Promise<string | null> {
  const exists = await queryOne<{ id: string }>(db, "SELECT id FROM teams WHERE id = ?", [teamId]);
  if (!exists) return `Team not found: ${teamId}`;

  const now = new Date().toISOString();
  const setClauses: string[] = [];
  const params: (string | number | null)[] = [];

  const scalarMap: Record<string, string> = {
    name: "name",
    domain: "domain",
    leadAgentId: "lead_agent_id",
    parentTeamId: "parent_team_id",
    description: "description",
  };
  const jsonColumns = new Set(["memberIds", "policies"]);

  for (const [key, value] of Object.entries(patch)) {
    if (jsonColumns.has(key)) {
      const col = key === "memberIds" ? "member_ids" : "policies";
      setClauses.push(`${col} = ?`);
      params.push(JSON.stringify(value));
    } else if (scalarMap[key]) {
      setClauses.push(`${scalarMap[key]} = ?`);
      params.push(value as string | null);
    }
  }

  if (setClauses.length === 0) return "No mappable fields in changeSet for team";

  setClauses.push("updated_at = ?");
  params.push(now, teamId);

  await run(db, `UPDATE teams SET ${setClauses.join(", ")} WHERE id = ?`, params);
  return null;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function markFailed(
  db: D1Database,
  proposalId: string,
  actorId: string | null,
  sessionId: string | null,
  error: string,
): Promise<ApplyChangeResult> {
  const now = new Date().toISOString();
  await run(db, "UPDATE proposals SET status='failed', updated_at=? WHERE id=?", [now, proposalId]);
  await emitEvent(db, "proposal.failed", actorId, "proposal", proposalId, { error }, sessionId);
  return { ok: false, error };
}

async function emitEvent(
  db: D1Database,
  kind: string,
  actorId: string | null,
  targetKind: string,
  targetId: string,
  payload: Record<string, unknown>,
  sessionId: string | null,
): Promise<void> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await run(
    db,
    `INSERT INTO events (id, kind, actor_id, target_kind, target_id, payload, session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, kind, actorId ?? null, targetKind, targetId, JSON.stringify(payload), sessionId ?? null, now, now],
  );
}
