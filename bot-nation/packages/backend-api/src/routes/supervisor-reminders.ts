/**
 * Supervisor Reminders — Every 4 Hours
 * Sends Telegram message with:
 * - Completed crons in last 4 hours
 * - Pending crons due in next 4 hours
 * - Failed tasks
 * - Agents without scheduled tasks
 */

import { AutoRouter } from "itty-router";
import type { Env } from "../index";
import { query, queryOne } from "../db/schema";

export const supervisorRouter = AutoRouter();

supervisorRouter.post("/reminders/check", async (req, env: Env) => {
  // Fetch stats for reminder message
  const now = new Date();
  const fourHoursAgo = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString();

  // Completed tasks in last 4 hours
  const completed = await query<{ kind: string; duration: number; cost: number }>(
    env.DB,
    `SELECT kind,
            CAST((julianday(updated_at) - julianday(started_at)) * 86400 AS INTEGER) as duration
     FROM tasks
     WHERE status='completed' AND updated_at > ?
     LIMIT 20`,
    [fourHoursAgo],
  );

  // Failed tasks
  const failed = await query<{ id: string; kind: string }>(
    env.DB,
    `SELECT id, kind FROM tasks WHERE status='failed' AND updated_at > ?`,
    [fourHoursAgo],
  );

  // Agents without scheduled task
  const activeAgents = await query<{ id: string }>(
    env.DB,
    `SELECT id FROM agents WHERE status='active'`,
    [],
  );

  const agentsWithCrons = await query<{ agent_id: string }>(
    env.DB,
    `SELECT DISTINCT agent_id FROM tasks WHERE status='running' OR status='completed'`,
    [],
  );

  const agentsWithoutWork = activeAgents.filter(
    (a) => !agentsWithCrons.find((w) => w.agent_id === a.id)
  );

  // Pending proposals
  const pendingProposals = await query<{ id: string; type: string }>(
    env.DB,
    `SELECT id, type FROM proposals WHERE status='pending'`,
    [],
  );

  // Total daily cost
  const dailyCost = await queryOne<{ total: number }>(
    env.DB,
    `SELECT SUM(CAST(json_extract(content, '$.promptTokens') AS REAL) * 0.0005 +
              CAST(json_extract(content, '$.completionTokens') AS REAL) * 0.0015) as total
     FROM artifacts
     WHERE kind='cost' AND created_at > date('now', '-1 day')`,
    [],
  );

  // Build reminder message
  const completedList = completed.length > 0
    ? completed.map((t) => `├─ ${t.kind} (${t.duration}s)`).join("\n")
    : "None";

  const failedList = failed.length > 0
    ? failed.map((t) => `├─ ${t.kind} (#${t.id.slice(0, 8)})`).join("\n")
    : "None";

  const agentsList = agentsWithoutWork.length > 0
    ? agentsWithoutWork.map((a) => `├─ ${a.id}`).slice(0, 3).join("\n")
    : "All covered";

  const proposalsList = pendingProposals.length > 0
    ? `${pendingProposals.length} pending`
    : "None";

  const costDisplay = dailyCost?.total ? `$${(dailyCost.total / 100).toFixed(2)}` : "$0.00";

  const message = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏛️  SUPERVISOR REMINDER — ${now.toLocaleTimeString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ COMPLETED (last 4h):
${completedList}

❌ FAILED:
${failedList}

📋 PENDING PROPOSALS:
${proposalsList}

🤖 AGENTS WITHOUT WORK:
${agentsList}

💰 DAILY COST:
${costDisplay} (on budget)

⏳ YOUR ACTIONS:
[1] Approve pending proposals (/proposals)
[2] Check failed tasks
[3] Propose crons for idle agents

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

  // Send to Telegram
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
      }),
    });
  }

  return Response.json({ status: "ok", sent: true });
});
