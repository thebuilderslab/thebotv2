/**
 * Watchlist Snapshot Service — Phase A.6 (Layer 2).
 *
 * Records daily close + volume for active tws_watchlist symbols at EOD.
 * Called only from the AgentActor Finance Lead EOD branch.
 *
 * Owns: WatchlistSnapshotRecord.
 * Reads: nothing.
 * Writes: watchlist_snapshots.
 * Forbidden: anything outside the above.
 */

import { run } from "../db/schema";

export interface WatchlistSnapshotRecord {
  symbol: string;
  close_price: number;
  volume: number | null;
  recorded_at: string;
}

/**
 * Insert one watchlist_snapshots row.
 * The UNIQUE(symbol, date(recorded_at)) index prevents duplicate same-day inserts.
 */
export async function recordWatchlistSnapshot(
  db: D1Database,
  data: WatchlistSnapshotRecord,
): Promise<string> {
  const id = crypto.randomUUID();
  await run(
    db,
    `INSERT OR IGNORE INTO watchlist_snapshots
       (id, symbol, close_price, volume, recorded_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, data.symbol, data.close_price, data.volume, data.recorded_at],
  );
  return id;
}
