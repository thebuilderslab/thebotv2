import { AutoRouter, type IRequest } from "itty-router";
import type { Env } from "../index";
import { queryOne, run } from "../db/schema";
import type { Approval, ApprovalDecision } from "@bot-nation/core-domain";
import { sendApprovalToTelegram } from "./telegram";

export const approvalsRouter = AutoRouter<IRequest, [Env, ExecutionContext]>();

approvalsRouter.get("/api/approvals", async (_req, env) => {
  const result = await env.DB.prepare(
    "SELECT * FROM approvals ORDER BY created_at DESC"
  ).all<Approval>();
  return Response.json(result.results);
});

approvalsRouter.get("/api/approvals/:id", async (req, env) => {
  const approval = await queryOne<Approval>(env.DB,
    "SELECT * FROM approvals WHERE id = ?", [req.params.id]);
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
  const body = await req.json<{
    decision: "approved" | "rejected";
    userId: string;
    channel: ApprovalDecision["channel"];
    rationale?: string;
  }>();
  const approval = await queryOne<{ decisions: string; status: string }>(env.DB,
    "SELECT decisions, status FROM approvals WHERE id = ?", [req.params.id]);
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
    [body.decision, JSON.stringify(decisions), now, req.params.id]);
  await run(env.DB, "UPDATE tasks SET status=?, updated_at=? WHERE approval_id=?",
    [body.decision, now, req.params.id]);
  return Response.json({ ok: true });
});