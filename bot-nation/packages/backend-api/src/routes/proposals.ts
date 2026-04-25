import { AutoRouter, type IRequest } from "itty-router";
import type { Env } from "../index";
import { query, queryOne, run } from "../db/schema";
import { sendApprovalToTelegram } from "./telegram";
import { evaluateRisk } from "../services/risk-evaluator";
import { checkProposalAgainstPolicy } from "../services/policy-enforcer";
import { applyChangeFromProposal } from "../services/change-apply";
import type { ApprovalBrief } from "@bot-nation/core-domain";

export const proposalsRouter = AutoRouter<IRequest, [Env, ExecutionContext]>();

// ─── GET /api/proposals ──────────────────────────────────────────────────────

proposalsRouter.get("/api/proposals", async (req, env) => {
  const rawStatus = req.query["status"];
  const status = Array.isArray(rawStatus) ? rawStatus[0] : rawStatus;
  const rows = status
    ? await query(env.DB,
        "SELECT * FROM proposals WHERE status = ? ORDER BY created_at DESC",
        [status])
    : await query(env.DB,
        "SELECT * FROM proposals ORDER BY created_at DESC");
  return Response.json(rows);
});

// ─── GET /api/proposals/:id ──────────────────────────────────────────────────

proposalsRouter.get("/api/proposals/:id", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });
  const proposal = await queryOne(env.DB,
    "SELECT * FROM proposals WHERE id = ?", [id]);
  if (!proposal) return new Response("Not found", { status: 404 });
  return Response.json(proposal);
});

// ─── POST /api/proposals ─────────────────────────────────────────────────────
// Creates a proposal in "draft" status.
// If riskLevel is omitted, it is auto-evaluated from the changeSet.

proposalsRouter.post("/api/proposals", async (req, env) => {
  const body = await req.json<{
    type: string;
    targetEntityKind: "agent" | "team" | "policy" | "tool";
    targetEntityId: string;
    requesterAgentId?: string;
    requesterTeamId?: string;
    requesterHumanId?: string;
    title: string;
    summary: string;
    changeSet: Record<string, unknown>;
    riskLevel?: "low" | "medium" | "high" | "critical";
    riskAffectsWallets?: boolean;
    riskAffectsDeployment?: boolean;
    riskNotes?: string;
  }>();

  if (!body.title || !body.summary || !body.targetEntityId || !body.targetEntityKind) {
    return Response.json(
      { error: "title, summary, targetEntityKind, and targetEntityId are required" },
      { status: 400 },
    );
  }

  const changeSet = body.changeSet ?? {};

  // Auto-evaluate risk if caller didn't supply it
  const autoRisk = evaluateRisk(changeSet, body.targetEntityKind);
  const riskLevel = body.riskLevel ?? autoRisk.level;
  const affectsWallets = body.riskAffectsWallets ?? autoRisk.affectsWallets;
  const affectsDeployment = body.riskAffectsDeployment ?? autoRisk.affectsDeployment;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await run(env.DB,
    `INSERT INTO proposals (
       id, type, target_entity_kind, target_entity_id,
       requester_agent_id, requester_team_id, requester_human_id,
       title, summary, change_set,
       risk_level, risk_affects_wallets, risk_affects_deployment, risk_notes,
       eval_passed, eval_benchmarks, eval_evaluated_at,
       approval_id, status, applied_at,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '[]', NULL, NULL, 'draft', NULL, ?, ?)`,
    [
      id,
      body.type ?? "config_change",
      body.targetEntityKind,
      body.targetEntityId,
      body.requesterAgentId ?? null,
      body.requesterTeamId ?? null,
      body.requesterHumanId ?? null,
      body.title,
      body.summary,
      JSON.stringify(changeSet),
      riskLevel,
      affectsWallets ? 1 : 0,
      affectsDeployment ? 1 : 0,
      body.riskNotes ?? null,
      now,
      now,
    ],
  );

  return Response.json(
    { id, status: "draft", riskLevel, affectsWallets, affectsDeployment },
    { status: 201 },
  );
});

// ─── POST /api/proposals/:id/submit ──────────────────────────────────────────
// Transitions draft → pending_approval (or directly to applied if auto-approved).
// Enforces team policy before proceeding.

proposalsRouter.post("/api/proposals/:id/submit", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });

  const proposal = await queryOne<{
    id: string;
    status: string;
    title: string;
    summary: string;
    risk_level: string;
    risk_affects_wallets: number;
    risk_affects_deployment: number;
    risk_notes: string | null;
    target_entity_kind: string;
    target_entity_id: string;
    requester_agent_id: string | null;
    requester_team_id: string | null;
    change_set: string;
  }>(env.DB, "SELECT * FROM proposals WHERE id = ?", [id]);

  if (!proposal) return new Response("Not found", { status: 404 });
  if (proposal.status !== "draft") {
    return Response.json(
      { error: `Cannot submit: proposal is already '${proposal.status}'` },
      { status: 409 },
    );
  }

  const changeSet: Record<string, unknown> = JSON.parse(proposal.change_set);

  // ── policy enforcement ───────────────────────────────────────────────────
  const policyResult = await checkProposalAgainstPolicy(
    env.DB,
    proposal.requester_team_id,
    proposal.risk_level,
    changeSet,
  );

  if (!policyResult.allowed) {
    return Response.json(
      { error: policyResult.reason ?? "Blocked by team policy" },
      { status: 403 },
    );
  }

  const now = new Date().toISOString();

  // ── auto-approve path ────────────────────────────────────────────────────
  // Only when team explicitly sets requiresHumanApproval: false AND risk is low
  if (policyResult.requiresHumanApproval === false && proposal.risk_level === "low") {
    await run(env.DB,
      "UPDATE proposals SET status='approved', updated_at=? WHERE id=?",
      [now, id],
    );
    const result = await applyChangeFromProposal(env.DB, id, proposal.requester_agent_id, null);
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 500 });
    }
    return Response.json({
      proposalId: id,
      status: "applied",
      appliedFields: result.appliedFields,
      message: "auto-approved (low risk, no human approval required)",
    });
  }

  // ── normal path: create Approval + send Telegram ─────────────────────────
  const approvalId = crypto.randomUUID();

  const brief: ApprovalBrief = {
    title: proposal.title,
    summary: proposal.summary,
    risk: proposal.risk_level as ApprovalBrief["risk"],
    expectedBenefit: `Update ${proposal.target_entity_kind} ${proposal.target_entity_id}`,
    blastRadius: [
      proposal.risk_affects_wallets ? "touches wallets" : null,
      proposal.risk_affects_deployment ? "affects deployment" : null,
      proposal.risk_notes ?? null,
    ].filter(Boolean).join("; ") || "limited to target entity",
  };

  await run(env.DB,
    `INSERT INTO approvals (id, task_id, requested_by_agent_id, brief, status, decisions, created_at, updated_at)
     VALUES (?, '', ?, ?, 'pending', '[]', ?, ?)`,
    [approvalId, proposal.requester_agent_id ?? null, JSON.stringify(brief), now, now],
  );

  await run(env.DB,
    "UPDATE proposals SET status='pending_approval', approval_id=?, updated_at=? WHERE id=?",
    [approvalId, now, id],
  );

  const eventId = crypto.randomUUID();
  await run(env.DB,
    `INSERT INTO events (id, kind, actor_id, target_kind, target_id, payload, session_id, created_at, updated_at)
     VALUES (?, 'proposal.created', ?, 'proposal', ?, ?, NULL, ?, ?)`,
    [
      eventId,
      proposal.requester_agent_id ?? null,
      id,
      JSON.stringify({
        approvalId,
        targetEntityKind: proposal.target_entity_kind,
        targetEntityId: proposal.target_entity_id,
      }),
      now,
      now,
    ],
  );

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    try {
      await sendApprovalToTelegram(env, approvalId, brief);
    } catch {
      // non-fatal
    }
  }

  return Response.json({ proposalId: id, approvalId, status: "pending_approval" });
});

// ─── PATCH /api/proposals/:id ─────────────────────────────────────────────────

proposalsRouter.patch("/api/proposals/:id", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });

  const existing = await queryOne<{ status: string }>(env.DB,
    "SELECT status FROM proposals WHERE id = ?", [id]);
  if (!existing) return new Response("Not found", { status: 404 });
  if (existing.status !== "draft") {
    return Response.json({ error: `Cannot edit: proposal is '${existing.status}'` }, { status: 409 });
  }

  const body = await req.json<{
    title?: string;
    summary?: string;
    changeSet?: Record<string, unknown>;
    riskLevel?: string;
    riskAffectsWallets?: boolean;
    riskAffectsDeployment?: boolean;
    riskNotes?: string;
  }>();

  const now = new Date().toISOString();
  await run(env.DB,
    `UPDATE proposals SET
       title              = COALESCE(?, title),
       summary            = COALESCE(?, summary),
       change_set         = COALESCE(?, change_set),
       risk_level         = COALESCE(?, risk_level),
       risk_affects_wallets     = COALESCE(?, risk_affects_wallets),
       risk_affects_deployment  = COALESCE(?, risk_affects_deployment),
       risk_notes         = COALESCE(?, risk_notes),
       updated_at         = ?
     WHERE id = ?`,
    [
      body.title ?? null,
      body.summary ?? null,
      body.changeSet !== undefined ? JSON.stringify(body.changeSet) : null,
      body.riskLevel ?? null,
      body.riskAffectsWallets !== undefined ? (body.riskAffectsWallets ? 1 : 0) : null,
      body.riskAffectsDeployment !== undefined ? (body.riskAffectsDeployment ? 1 : 0) : null,
      body.riskNotes ?? null,
      now,
      id,
    ],
  );

  return Response.json({ ok: true });
});
