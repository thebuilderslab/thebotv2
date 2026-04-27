export async function query<T>(
  db: D1Database,
  sql: string,
  params: (string | number | null)[] = []
): Promise<T[]> {
  const result = await db.prepare(sql).bind(...params).all<T>();
  return result.results;
}

export async function queryOne<T>(
  db: D1Database,
  sql: string,
  params: (string | number | null)[] = []
): Promise<T | null> {
  const result = await db.prepare(sql).bind(...params).first<T>();
  return result ?? null;
}

export async function run(
  db: D1Database,
  sql: string,
  params: (string | number | null)[] = []
): Promise<D1Result> {
  return db.prepare(sql).bind(...params).run();
}

// ── Compare-And-Swap (CAS) primitive ─────────────────────────────────────────
// The universal pattern for state-machine transitions on tasks / approvals /
// proposals / pending_orders / scheduled_crons / code_changes. See
// migration 0040 + the bot-nation CAS rollout doc for the full taxonomy.
//
//   const claimed = await claimRow(db, "tasks", taskId, {
//     fromStatus: "pending",
//     toStatus:   "running",
//     claimedBy:  agentId,
//   });
//   if (!claimed) return; // somebody else got there first — silent no-op
//
// claimedBy is optional but strongly recommended — it's what gives every state
// transition a blame trail in the audit log.
export interface ClaimOptions {
  fromStatus: string;
  toStatus:   string;
  claimedBy?: string;        // optional: who took the lock (agent id, "operator", "cron_<key>", etc.)
  table?:     string;        // override the column-set for tables without claimed_by
  hasClaimedBy?: boolean;    // explicit opt-out for tables that lack the column (default true)
  extraSets?: string;        // optional extra `, col=?` segments
  extraParams?: (string | number | null)[];
}

export async function claimRow(
  db: D1Database,
  table: string,
  id: string,
  opts: ClaimOptions,
): Promise<boolean> {
  const now = new Date().toISOString();
  const hasClaimedBy = opts.hasClaimedBy !== false;
  const setClaimedBy = hasClaimedBy ? ", claimed_by=?" : "";
  const extra        = opts.extraSets ? `, ${opts.extraSets}` : "";

  const params: (string | number | null)[] = [opts.toStatus, now];
  if (hasClaimedBy) params.push(opts.claimedBy ?? null);
  if (opts.extraParams) params.push(...opts.extraParams);
  params.push(id, opts.fromStatus);

  const sql =
    `UPDATE ${table} SET status=?, updated_at=?${setClaimedBy}${extra} ` +
    `WHERE id=? AND status=?`;

  const result = await db.prepare(sql).bind(...params).run();
  return Boolean(result.meta?.changes && result.meta.changes > 0);
}
