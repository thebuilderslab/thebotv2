// OpenRouter Balance Report — weekly
//
// Called by the "0 13 * * MON" cron (Monday 9am ET). Fetches the OpenRouter
// account balance and Telegrams it to the operator — always stating the
// current balance, flagging when it's below $1, and reporting the raw error
// text if the fetch fails. Report-only: no circuit-breaker, never blocks tasks.

import { run } from "../db/schema";
import type { Env } from "../index";

const CREDITS_URL = "https://openrouter.ai/api/v1/credits";
const LOW_BALANCE_THRESHOLD_USD = 1.0;
const TOPUP_URL = "https://openrouter.ai/settings/credits";
const AGENT_ID = "agent-finance-lead"; // reuse existing agent_notes owner

interface CreditsResponse {
  data?: { total_credits?: number; total_usage?: number };
}

// ── Pure formatter (unit-tested) ──────────────────────────────────────────────

export function formatBalanceReport(
  totalCredits: number,
  totalUsage: number,
  threshold = LOW_BALANCE_THRESHOLD_USD,
): string {
  const remaining = totalCredits - totalUsage;
  const fmt = (n: number) => `$${n.toFixed(2)}`;
  let msg = `💳 <b>OpenRouter balance:</b> ${fmt(remaining)} remaining (used ${fmt(totalUsage)} of ${fmt(totalCredits)}).`;
  if (remaining < threshold) {
    msg += `\n⚠️ Low — top up at ${TOPUP_URL}`;
  }
  return msg;
}

// ── Telegram sender ───────────────────────────────────────────────────────────

async function sendTelegram(env: Env, text: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(8_000),
  }).catch((e) => console.error("[openrouter-balance] telegram send failed:", e));
}

async function storeBalance(env: Env, remaining: number, now: string): Promise<void> {
  const upsert = (key: string, value: string) =>
    run(
      env.DB,
      `INSERT INTO agent_notes (id, agent_id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      [crypto.randomUUID(), AGENT_ID, key, value, now, now],
    ).catch((e) => console.error(`[openrouter-balance] store ${key} failed:`, e));
  await Promise.all([
    upsert("openrouter_balance_usd", remaining.toFixed(4)),
    upsert("openrouter_balance_checked_at", now),
  ]);
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function checkOpenRouterBalance(env: Env): Promise<void> {
  if (!env.OPENROUTER_API_KEY) {
    await sendTelegram(env, "❌ <b>OpenRouter balance check skipped</b>\nOPENROUTER_API_KEY not set.");
    return;
  }

  const now = new Date().toISOString();
  try {
    const resp = await fetch(CREDITS_URL, {
      headers: { "Authorization": `Bearer ${env.OPENROUTER_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      await sendTelegram(
        env,
        `❌ <b>OpenRouter balance check failed</b>\n<code>${resp.status} ${body.slice(0, 300)}</code>`,
      );
      return;
    }

    const data = (await resp.json()) as CreditsResponse;
    const totalCredits = data.data?.total_credits ?? 0;
    const totalUsage = data.data?.total_usage ?? 0;
    const remaining = totalCredits - totalUsage;

    await storeBalance(env, remaining, now);
    await sendTelegram(env, formatBalanceReport(totalCredits, totalUsage));
    console.log(`[openrouter-balance] reported $${remaining.toFixed(2)} remaining`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendTelegram(env, `❌ <b>OpenRouter balance check errored</b>\n<code>${msg.slice(0, 300)}</code>`);
  }
}
