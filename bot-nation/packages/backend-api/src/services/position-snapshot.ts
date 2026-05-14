/**
 * Position Snapshot Service
 *
 * Records position state + policy decision at specific points in time.
 * Called:
 *   - Daily (EOD wrap-up by Finance Lead agent)
 *   - On-trade (after every decision is made)
 *
 * Enables:
 *   - Replay: "what-if" analysis with historical thresholds
 *   - Missed actions: compare decisions vs. what could have been
 *   - Learning: train models on decision patterns
 */

import { run, query } from "../db/schema";
import type { PolicyThresholds, Position, PolicyDecision } from "./policy-impact-model";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PositionSnapshotRecord {
  agent_id: string;
  symbol: string;
  position_type: string;
  quantity: number;
  entry_price: number;
  current_price: number;
  current_pnl_pct: number;
  days_to_expiry: number;
  delta?: number;
  theta?: number;
  vega?: number;
  underlying_price: number;
  policy_decision: string;
  decision_rationale: string;
  thresholds_at_snapshot: PolicyThresholds;
  snapshot_type: 'daily' | 'on_trade';  // cadence marker
}

export interface MissedActionRecord {
  agent_id?: string;
  symbol: string;
  missed_action_type: 'SHOULD_HAVE_CLOSED' | 'SHOULD_HAVE_ROLLED' | 'ALTERNATIVE_TRADE';
  entry_price: number;
  missed_at: string;
  current_price: number;
  opportunity_cost: number;
  manual_trade_taken?: string;
  notes: string;
}

// ── Snapshot Recording ────────────────────────────────────────────────────────

/**
 * Record a position snapshot (daily or on-trade).
 * Used to audit decisions and enable missed-action detection.
 */
export async function recordPositionSnapshot(
  db: D1Database,
  data: PositionSnapshotRecord,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const threshholdsJson = JSON.stringify(data.thresholds_at_snapshot);

  await run(
    db,
    `INSERT INTO position_snapshots (
       id, agent_id, timestamp, symbol, position_type,
       quantity, entry_price, current_price, current_pnl_pct,
       days_to_expiry, delta, theta, vega, underlying_price,
       policy_decision, decision_rationale, thresholds_at_snapshot,
       created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.agent_id,
      now,
      data.symbol,
      data.position_type,
      data.quantity,
      data.entry_price,
      data.current_price,
      data.current_pnl_pct,
      data.days_to_expiry,
      data.delta ?? null,
      data.theta ?? null,
      data.vega ?? null,
      data.underlying_price,
      data.policy_decision,
      data.decision_rationale,
      threshholdsJson,
      now,
    ],
  );

  return id;
}

/**
 * Record a missed action (threshold crossing or alternative trade).
 */
export async function recordMissedAction(
  db: D1Database,
  data: MissedActionRecord,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await run(
    db,
    `INSERT INTO missed_actions (
       id, agent_id, symbol, missed_action_type,
       entry_price, missed_at, current_price, opportunity_cost,
       manual_trade_taken, notes, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.agent_id ?? null,
      data.symbol,
      data.missed_action_type,
      data.entry_price,
      data.missed_at,
      data.current_price,
      data.opportunity_cost,
      data.manual_trade_taken ?? null,
      data.notes,
      now,
    ],
  );

  return id;
}

// ── Snapshot Queries ──────────────────────────────────────────────────────────

/**
 * Get the most recent snapshot for a symbol.
 */
export async function getLatestSnapshot(
  db: D1Database,
  symbol: string,
  agentId?: string,
): Promise<any | null> {
  const conditions = ['symbol = ?'];
  const params: any[] = [symbol];

  if (agentId) {
    conditions.push('agent_id = ?');
    params.push(agentId);
  }

  const result = await query(
    db,
    `SELECT * FROM position_snapshots
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC
     LIMIT 1`,
    params,
  );

  return result.length > 0 ? result[0] : null;
}

/**
 * Get all snapshots for a symbol over a date range (e.g., last 30 days).
 */
export async function getSnapshotHistory(
  db: D1Database,
  symbol: string,
  daysBefore: number = 30,
  agentId?: string,
): Promise<any[]> {
  const conditions = [
    'symbol = ?',
    `created_at >= datetime('now', '-${daysBefore} days')`,
  ];
  const params: any[] = [symbol];

  if (agentId) {
    conditions.push('agent_id = ?');
    params.push(agentId);
  }

  return query(
    db,
    `SELECT * FROM position_snapshots
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC`,
    params,
  );
}

/**
 * Compare two snapshots to detect missed actions.
 * Example: if P&L moved from +50% → +250% but decision stayed HOLD, it's a miss.
 */
export async function compareMissedActions(
  db: D1Database,
  symbol: string,
  agentId: string,
): Promise<MissedActionRecord[]> {
  const snapshots = await getSnapshotHistory(db, symbol, 30, agentId);
  const missed: MissedActionRecord[] = [];

  if (snapshots.length < 2) return [];

  // Sort oldest first
  snapshots.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  for (let i = 0; i < snapshots.length - 1; i++) {
    const prev = snapshots[i];
    const curr = snapshots[i + 1];
    const currentPnlPct = curr.current_pnl_pct || 0;
    const prevPnlPct = prev.current_pnl_pct || 0;

    // Detect: should have closed but didn't
    if (
      prevPnlPct <= -0.30 &&
      curr.policy_decision !== 'CLOSE' &&
      curr.policy_decision !== 'ESCALATE'
    ) {
      missed.push({
        agent_id: agentId,
        symbol,
        missed_action_type: 'SHOULD_HAVE_CLOSED',
        entry_price: curr.entry_price,
        missed_at: prev.created_at,
        current_price: curr.current_price,
        opportunity_cost: (currentPnlPct - prevPnlPct) * (curr.entry_price * 100 * curr.quantity), // rough estimate
        manual_trade_taken: undefined,
        notes: `Stop-loss triggered (P&L ${(prevPnlPct * 100).toFixed(1)}%) but position held`,
      });
    }

    // Detect: should have rolled but didn't
    if (
      curr.days_to_expiry <= 2 &&
      prev.days_to_expiry > 2 &&
      curr.policy_decision === 'HOLD'
    ) {
      missed.push({
        agent_id: agentId,
        symbol,
        missed_action_type: 'SHOULD_HAVE_ROLLED',
        entry_price: curr.entry_price,
        missed_at: prev.created_at,
        current_price: curr.current_price,
        opportunity_cost: (curr.current_pnl_pct || 0) * (curr.entry_price * 100 * curr.quantity),
        notes: `DTE dropped from ${prev.days_to_expiry} to ${curr.days_to_expiry} but no roll issued`,
      });
    }

    // Detect: alternative trade opportunity
    if (
      currentPnlPct >= 1.5 &&
      prevPnlPct <= 1.0 &&
      curr.policy_decision === 'HOLD'
    ) {
      missed.push({
        agent_id: agentId,
        symbol,
        missed_action_type: 'ALTERNATIVE_TRADE',
        entry_price: curr.entry_price,
        missed_at: prev.created_at,
        current_price: curr.current_price,
        opportunity_cost: (currentPnlPct - 1.0) * (curr.entry_price * 100 * curr.quantity),
        notes: `Target reached (P&L ${(currentPnlPct * 100).toFixed(1)}%) but HOLD chosen; could have rolled for additional credit`,
      });
    }
  }

  return missed;
}

/**
 * Get missed actions for a date range.
 */
export async function getMissedActions(
  db: D1Database,
  startDate: string,
  endDate: string,
  symbol?: string,
): Promise<any[]> {
  const conditions = [
    `detected_at >= ?`,
    `detected_at <= ?`,
  ];
  const params: any[] = [startDate, endDate];

  if (symbol) {
    conditions.push('symbol = ?');
    params.push(symbol);
  }

  return query(
    db,
    `SELECT * FROM missed_actions
     WHERE ${conditions.join(' AND ')}
     ORDER BY detected_at DESC`,
    params,
  );
}
