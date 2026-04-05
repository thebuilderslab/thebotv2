import { AutoRouter, type IRequest } from "itty-router";
import type { Env } from "../index";
import { query, queryOne, run } from "../db/schema";
import type { Approval, ApprovalDecision } from "@bot-nation/core-domain";
import { sendApprovalToTelegram } from "./telegram";
import { applyChangeForApproval } from "../services/change-apply";

export const approvalsRouter = AutoRouter<IRequest, [Env, ExecutionContext]>();

approvalsRouter.get("/api/approvals", async (_req, env) => {
  const result = await env.DB.prepare(
    "SELECT * FROM approvals ORDER BY created_at DESC"
  ).all<Approval>();
  return Response.json(result.results);
});

// ─── GET /api/approvals/inbox ────────────────────────────────────────────────
// Must be registered BEFORE /:id to avoid route shadowing.

approvalsRouter.get("/api/approvals/inbox", async (_req, env) => {
  const rows = await query(env.DB,
    `SELECT
       a.id,
       a.task_id,
       a.requested_by_agent_id,
       a.brief,
       a.status,
       a.decisions,
       a.created_at,
       a.updated_at,
       p.id              AS proposal_id,
       p.title           AS proposal_title,
       p.type            AS proposal_type,
       p.risk_level,
       p.risk_affects_wallets,
       p.risk_affects_deployment,
       p.target_entity_kind,
       p.target_entity_id,
       p.change_set
     FROM approvals a
     LEFT JOIN proposals p ON p.approval_id = a.id
     WHERE a.status = 'pending'
     ORDER BY a.created_at DESC`,
  );
  return Response.json(rows);
});

approvalsRouter.get("/api/approvals/:id", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });
  const approval = await queryOne<Approval>(env.DB,
    "SELECT * FROM approvals WHERE id = ?", [id]);
  if (!approval) return new Response("Not found", { status: 404 });
  return Response.json(approval);
});

approvalsRouter.post("/api/approvals", async (req, env) => {
  const body = await req.json<Omit<Approval, "id" | "createdAt" | "updatedAt" | "status" | "decisions">>();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await run(env.DB,
    `INSERT INTO approvals (id, task_id, requested_by_agent_id, brief, status, decisions, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', '[]', ?, ?)`,
    [id, body.taskId, body.requestedByAgentId ?? null, JSON.stringify(body.brief), now, now]
  );
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    await sendApprovalToTelegram(env, id, body.brief);
  }
  return Response.json({ id }, { status: 201 });
});

approvalsRouter.post("/api/approvals/:id/decision", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });
  const body = await req.json<{
    decision: "approved" | "rejected";
    userId: string;
    channel: ApprovalDecision["channel"];
    rationale?: string;
  }>();
  const approval = await queryOne<{ decisions: string; status: string }>(env.DB,
    "SELECT decisions, status FROM approvals WHERE id = ?", [id]);
  if (!approval) return new Response("Not found", { status: 404 });
  if (approval.status !== "pending") return Response.json({ error: "Already decided" }, { status: 409 });
  const decisions: ApprovalDecision[] = JSON.parse(approval.decisions);
  decisions.push({
    status: body.decision,
    decidedByUserId: body.userId,
    decidedAt: new Date().toISOString(),
    channel: body.channel,
    rationale: body.rationale,
  });
  const now = new Date().toISOString();
  await run(env.DB, "UPDATE approvals SET status=?, decisions=?, updated_at=? WHERE id=?",
    [body.decision, JSON.stringify(decisions), now, id]);
  await run(env.DB, "UPDATE tasks SET status=?, updated_at=? WHERE approval_id=?",
    [body.decision, now, id]);

  // Apply the changeSet if this approval is linked to a proposal
  if (body.decision === "approved") {
    await applyChangeForApproval(env.DB, id, body.userId, null);
  }

  return Response.json({ ok: true });
});
