/**
 * Cron CAS — universal lock primitive for scheduled handlers.
 *
 * Closes section 1 #5 + section 3 of the bot-nation CAS rollout.
 *
 * Usage at the top of every scheduled handler:
 *
 *   const claim = await claimCronTick(env.DB, "supervisor_digest", { ttlMs: 4 * 60_000 });
 *   if (!claim.ok) {
 *     console.log(`[cron] supervisor_digest skipped — ${claim.reason}`);
 *     return;
 *   }
 *   try {
 *     // ... handler body ...
 *   } finally {
 *     await releaseCronTick(env.DB, "supervisor_digest");
 *   }
 *
 * If a previous tick is still mid-flight, the new tick is a no-op. If a tick
 * died without releasing (Worker crash), the next tick after `expires_at`
 * passes will reclaim the lock — so locks self-heal.
 */

import { run, queryOne } from "../db/schema";

export interface CronClaim {
  ok: boolean;
  reason?: "already_running" | "claimed";
}

export async function claimCronTick(
  db: D1Database,
  cronKey: string,
  opts: { ttlMs?: number } = {},
): Promise<CronClaim> {
  const now = new Date();
  const ttlMs = opts.ttlMs ?? 5 * 60 * 1000; // default 5 min runtime budget
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const nowIso = now.toISOString();

  // Look up existing lock state.
  const existing = await queryOne<{ status: string; expires_at: string }>(
    db,
    "SELECT status, expires_at FROM cron_locks WHERE cron_key=?",
    [cronKey],
  );

  if (!existing) {
    // First tick ever for this key — INSERT OR IGNORE handles concurrent first-ticks.
    await run(
      db,
      `INSERT OR IGNORE INTO cron_locks (cron_key, status, claimed_at, expires_at, run_count, updated_at)
       VALUES (?, 'running', ?, ?, 1, ?)`,
      [cronKey, nowIso, expiresAt, nowIso],
    );
    // Verify we actually got the row (lost the race → another tick won).
    const verify = await queryOne<{ status: string }>(
      db,
      "SELECT status FROM cron_locks WHERE cron_key=? AND claimed_at=?",
      [cronKey, nowIso],
    );
    return verify ? { ok: true, reason: "claimed" } : { ok: false, reason: "already_running" };
  }

  // Stale lock — overdue, treat as released.
  const stale = existing.status === "running" && existing.expires_at < nowIso;

  if (existing.status === "running" && !stale) {
    return { ok: false, reason: "already_running" };
  }

  // Atomic claim: only flip to running if still in the previous state we observed.
  const claim = await db.prepare(
    `UPDATE cron_locks
     SET status='running', claimed_at=?, expires_at=?, run_count=run_count+1, updated_at=?
     WHERE cron_key=? AND status=?`,
  ).bind(nowIso, expiresAt, nowIso, cronKey, existing.status).run();

  if (claim.meta?.changes && claim.meta.changes > 0) {
    return { ok: true, reason: "claimed" };
  }
  return { ok: false, reason: "already_running" };
}

export async function releaseCronTick(
  db: D1Database,
  cronKey: string,
): Promise<void> {
  const now = new Date().toISOString();
  await run(
    db,
    "UPDATE cron_locks SET status='idle', last_run_at=?, updated_at=? WHERE cron_key=?",
    [now, now, cronKey],
  );
}

/**
 * Convenience wrapper: claim → run → release with try/finally.
 * Returns whatever the handler returns, or null if the tick was skipped.
 */
export async function withCronLock<T>(
  db: D1Database,
  cronKey: string,
  ttlMs: number,
  handler: () => Promise<T>,
): Promise<T | null> {
  const claim = await claimCronTick(db, cronKey, { ttlMs });
  if (!claim.ok) {
    console.log(`[cron] ${cronKey} skipped — ${claim.reason}`);
    return null;
  }
  try {
    return await handler();
  } finally {
    await releaseCronTick(db, cronKey);
  }
}
