import { AutoRouter } from "itty-router";
import type { Env } from "../index";
import type { ApprovalBrief } from "@bot-nation/core-domain";
import { applyChangeForApproval } from "../services/change-apply";

export const telegramRouter = AutoRouter();

telegramRouter.post("/telegram", async (req, env: Env) => {
  const update = (await req.json()) as TelegramUpdate;

  if (update.message) {
    const chatId = update.message.chat.id;
    const text = update.message.text?.trim() ?? "";

    if (text === "/start") {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: "Nexus approval bot is online. I'll send approval requests here.",
        }),
      });

      return new Response("OK");
    }
  }

  if (update.callback_query) {
    const { data } = update.callback_query;
    if (!data) return new Response("OK");

    const [, approvalId, decision] = data.split(":");
    if (!approvalId || !decision) return new Response("OK");
    if (decision !== "approved" && decision !== "rejected") return new Response("OK");

    const now = new Date().toISOString();

    await env.DB.prepare("UPDATE approvals SET status=?, updated_at=? WHERE id=?")
      .bind(decision, now, approvalId)
      .run();

    await env.DB.prepare("UPDATE tasks SET status=?, updated_at=? WHERE approval_id=?")
      .bind(decision, now, approvalId)
      .run();

    // Apply the changeSet if this approval is linked to a proposal
    let applyNote = "";
    if (decision === "approved") {
      const result = await applyChangeForApproval(
        env.DB,
        approvalId,
        String(update.callback_query.from.id),
        null,
      );
      applyNote = result.ok && result.appliedFields.length > 0
        ? ` · applied ${result.appliedFields.length} field(s)`
        : "";
    }

    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: update.callback_query.id,
        text: `Marked as ${decision}${applyNote}`,
      }),
    });
  }

  return new Response("OK");
});

export async function sendApprovalToTelegram(
  env: Env,
  approvalId: string,
  brief: ApprovalBrief,
): Promise<void> {
  const emoji: Record<string, string> = {
    low: "🟢",
    medium: "🟡",
    high: "🔴",
    critical: "🚨",
  };

  const text =
    `*${brief.title}*\n\n${brief.summary}\n\n` +
    `${emoji[brief.risk] ?? "⚪"} Risk: *${brief.risk}*\n` +
    `💡 Benefit: ${brief.expectedBenefit}\n` +
    `💥 Blast radius: ${brief.blastRadius}`;

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Approve", callback_data: `approval:${approvalId}:approved` },
            { text: "Reject", callback_data: `approval:${approvalId}:rejected` },
          ],
        ],
      },
    }),
  });
}

interface TelegramUpdate {
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number };
    from?: { id: number; username?: string };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
  };
}