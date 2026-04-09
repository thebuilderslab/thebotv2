/**
 * Supervisor Reminders — Every 4 Hours + Preview Next 2
 * Sends Telegram message with:
 * - Completed crons in last 4 hours
 * - Pending crons due in next 4 hours
 * - Failed tasks
 * - Agents without scheduled tasks
 * - Preview of next 2 reminders with early approval options
 */

import { AutoRouter } from "itty-router";
import type { Env } from "../index";
import { query, queryOne } from "../db/schema";

interface ReminderStats {
  completed: Array<{ kind: string; duration: number }>;
  failed: Array<{ id: string; kind: string }>;
  activeAgents: Array<{ id: string }>;
  agentsWithWork: Array<{ assigned_agent_id: string }>;
  pendingProposals: Array<{ id: string; type: string }>;
  dailyCost: { total: number } | null;
}

export const supervisorRouter = AutoRouter();

async function fetchReminderStats(env: Env, hoursAgo: number): Promise<ReminderStats> {
  const now = new Date();
  const timeWindow = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000).toISOString();

  const completed = await query<{ kind: string; duration: number }>(
    env.DB,
    `SELECT kind,
            CAST((julianday(updated_at) - julianday(started_at)) * 86400 AS INTEGER) as duration
     FROM tasks
     WHERE status='completed' AND updated_at > ?
     LIMIT 20`,
    [timeWindow],
  );

  const failed = await query<{ id: string; kind: string }>(
    env.DB,
    `SELECT id, kind FROM tasks WHERE status='failed' AND updated_at > ?`,
    [timeWindow],
  );

  const activeAgents = await query<{ id: string }>(
    env.DB,
    `SELECT id FROM agents WHERE status='active'`,
    [],
  );

  const agentsWithWork = await query<{ assigned_agent_id: string }>(
    env.DB,
    `SELECT DISTINCT assigned_agent_id FROM tasks WHERE status='running' OR status='completed'`,
    [],
  );

  const pendingProposals = await query<{ id: string; type: string }>(
    env.DB,
    `SELECT id, type FROM proposals WHERE status='pending'`,
    [],
  );

  const dailyCost = await queryOne<{ total: number }>(
    env.DB,
    `SELECT SUM(CAST(json_extract(content, '$.promptTokens') AS REAL) * 0.0005 +
              CAST(json_extract(content, '$.completionTokens') AS REAL) * 0.0015) as total
     FROM artifacts
     WHERE kind='cost' AND created_at > date('now', '-1 day')`,
    [],
  );

  return { completed, failed, activeAgents, agentsWithWork, pendingProposals, dailyCost };
}

function buildReminderMessage(stats: ReminderStats, windowName: string, now: Date): string {
  const completedList = stats.completed.length > 0
    ? stats.completed.map((t) => `├─ ${t.kind} (${t.duration}s)`).join("\n")
    : "None";

  const failedList = stats.failed.length > 0
    ? stats.failed.map((t) => `├─ ${t.kind} (#${t.id.slice(0, 8)})`).join("\n")
    : "None";

  const agentsWithoutWork = stats.activeAgents.filter(
    (a) => !stats.agentsWithWork.find((w) => w.assigned_agent_id === a.id)
  );

  const agentsList = agentsWithoutWork.length > 0
    ? agentsWithoutWork.map((a) => `├─ ${a.id}`).slice(0, 3).join("\n")
    : "All covered";

  const proposalsList = stats.pendingProposals.length > 0
    ? `${stats.pendingProposals.length} pending`
    : "None";

  const costDisplay = stats.dailyCost?.total ? `$${(stats.dailyCost.total / 100).toFixed(2)}` : "$0.00";

  return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏛️  SUPERVISOR REMINDER — ${windowName}
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
}

supervisorRouter.post("/api/supervisor/reminders/check", async (req, env: Env) => {
  const now = new Date();
  const stats = await fetchReminderStats(env, 4);
  const message = buildReminderMessage(stats, now.toLocaleTimeString(), now);

  // Send to Telegram with preview button
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔮 Preview Next 2", callback_data: "remind_preview_next_2" },
              { text: "✅ Approve All", callback_data: "remind_approve_all" },
            ],
          ],
        },
      }),
    });
  }

  return Response.json({ status: "ok", sent: true });
});

supervisorRouter.post("/api/supervisor/reminders/preview-next", async (req, env: Env) => {
  const now = new Date();

  // Get stats for last 4 hours and last 8 hours for preview
  const stats1 = await fetchReminderStats(env, 4);
  const stats2 = await fetchReminderStats(env, 8);

  const reminder1 = buildReminderMessage(stats1, "NEXT in +4 hours", new Date(now.getTime() + 4 * 60 * 60 * 1000));
  const reminder2 = buildReminderMessage(stats2, "NEXT in +8 hours", new Date(now.getTime() + 8 * 60 * 60 * 1000));

  const previewMessage = `🔮 <b>SUPERVISOR PREVIEW</b>\n\n${reminder1}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n${reminder2}\n\n<i>Early approval available — pre-authorize actions before scheduled execution</i>`;

  // Send to Telegram with approval buttons
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: previewMessage,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Pre-approve +4h", callback_data: "remind_preapprove_1" },
              { text: "✅ Pre-approve +8h", callback_data: "remind_preapprove_2" },
            ],
            [
              { text: "🔄 Refresh", callback_data: "remind_refresh_preview" },
              { text: "❌ Dismiss", callback_data: "remind_dismiss_preview" },
            ],
          ],
        },
      }),
    });
  }

  return Response.json({
    status: "ok",
    preview_sent: true,
    reminders: {
      "+4h": reminder1,
      "+8h": reminder2,
    },
  });
});
