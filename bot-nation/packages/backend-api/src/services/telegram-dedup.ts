/**
 * Outbound Telegram dedup — closes section 1 #6 of the CAS rollout.
 *
 * Supervisor digests + auto-answer + reminders can all independently emit the
 * same alert for the same chat in the same hour. This wraps sendMessage with
 * an INSERT OR IGNORE on (chat_id, route_type, hour_bucket, content_hash). If
 * the row already exists, the send is a no-op and we return { sent: false }.
 *
 *   const result = await sendDedupedTelegram(env, {
 *     chatId,
 *     routeType: "supervisor_digest",
 *     text: digestMarkdown,
 *     hourBucket: hourBucketFor(new Date()),
 *   });
 *   if (!result.sent) console.log("[tg-dedup] suppressed duplicate");
 */

import { run, queryOne } from "../db/schema";

export interface DedupSendOptions {
  chatId:     number | string;
  routeType:  string;          // e.g. "supervisor_digest", "gap_recovery_alert"
  text:       string;
  hourBucket?: string;         // override; default = current hour ISO
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
  replyMarkup?: unknown;
}

export interface DedupSendResult {
  sent: boolean;
  reason?: "duplicate" | "send_failed" | "no_token";
  error?: string;
}

/** ISO hour bucket — "2026-04-26T22" — used as the dedup time window. */
export function hourBucketFor(d: Date = new Date()): string {
  return d.toISOString().slice(0, 13);
}

/** SHA-1 hex of input (Cloudflare Workers crypto.subtle available). */
async function sha1Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sendDedupedTelegram(
  env: { DB: D1Database; TELEGRAM_BOT_TOKEN?: string },
  opts: DedupSendOptions,
): Promise<DedupSendResult> {
  if (!env.TELEGRAM_BOT_TOKEN) return { sent: false, reason: "no_token" };

  const hour      = opts.hourBucket ?? hourBucketFor(new Date());
  const chatStr   = String(opts.chatId);
  const hash      = (await sha1Hex(opts.text)).slice(0, 16); // 64-bit prefix is plenty
  const dedupKey  = `${chatStr}:${opts.routeType}:${hour}:${hash}`;
  const now       = new Date().toISOString();

  // Atomic claim — INSERT OR IGNORE returns changes=0 if the row was already there.
  const claim = await env.DB.prepare(
    `INSERT OR IGNORE INTO telegram_outbound_dedup
       (dedup_key, chat_id, route_type, hour_bucket, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(dedupKey, chatStr, opts.routeType, hour, now).run();

  if (!claim.meta?.changes) {
    return { sent: false, reason: "duplicate" };
  }

  // We won the claim — send it.
  try {
    const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id:      chatStr,
        text:         opts.text,
        parse_mode:   opts.parseMode ?? "HTML",
        ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!resp.ok) {
      // Roll back the dedup row so a retry can succeed — otherwise a transient
      // 5xx silences the alert for the whole hour.
      await run(
        env.DB,
        "DELETE FROM telegram_outbound_dedup WHERE dedup_key=?",
        [dedupKey],
      );
      return { sent: false, reason: "send_failed", error: `Telegram ${resp.status}` };
    }
    return { sent: true };
  } catch (err) {
    await run(
      env.DB,
      "DELETE FROM telegram_outbound_dedup WHERE dedup_key=?",
      [dedupKey],
    );
    return { sent: false, reason: "send_failed", error: String(err) };
  }
}

// Re-export for convenience — some callers will want to check dedup state
// without sending (e.g. to log "would-have-sent").
export async function isDedupedRecently(
  db: D1Database,
  chatId: number | string,
  routeType: string,
  hourBucket?: string,
): Promise<boolean> {
  const hour = hourBucket ?? hourBucketFor(new Date());
  const row = await queryOne<{ dedup_key: string }>(
    db,
    "SELECT dedup_key FROM telegram_outbound_dedup WHERE chat_id=? AND route_type=? AND hour_bucket=? LIMIT 1",
    [String(chatId), routeType, hour],
  );
  return row !== null;
}
