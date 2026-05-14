/**
 * Metrics Backfill Service
 *
 * Extracts 30 days of historical trade decisions from agent_notes
 * and seeds the trade_decision_quality_metrics table on first deployment.
 *
 * Called once during migration 0043 deployment, or manually via /task.
 * Enables day-1 feedback loop without waiting 30 days for natural history.
 */

import { run, query } from "../db/schema";

interface NoteRow {
  key: string;
  value: string;
  created_at: string;
}

interface SnapshotRow {
  symbol: string;
  policy_decision: string;
  current_pnl_pct: number;
  days_to_expiry: number;
  created_at: string;
}

interface MetricDef {
  name: string;
  value: number;
  target: number;
}

function dateOnly(ts: string): string {
  return ts.split("T")[0] ?? ts.slice(0, 10);
}

function statusFor(value: number, target: number): "on_target" | "below_target" {
  return value >= target ? "on_target" : "below_target";
}

/**
 * Backfill metrics from historical agent_notes entries.
 * Parses decision patterns and calculates metrics for past 30 days.
 */
export async function backfillMetrics(
  db: D1Database,
  agentId: string = "agent-finance-lead",
  daysBack: number = 30,
): Promise<void> {
  const notes = await query<NoteRow>(
    db,
    `SELECT key, value, created_at FROM agent_notes
     WHERE agent_id = ? AND created_at >= datetime('now', ?)
     ORDER BY created_at DESC`,
    [agentId, `-${daysBack} days`],
  );

  const dailyDecisions: Map<string, Array<{ action: string; pnl?: number }>> = new Map();

  for (const note of notes) {
    const holdMatches = (note.value.match(/HOLD/gi) || []).length;
    const rollMatches = (note.value.match(/ROLL/gi) || []).length;
    const closeMatches = (note.value.match(/CLOSE/gi) || []).length;
    const escalateMatches = (note.value.match(/ESCALATE/gi) || []).length;

    const pnlMatches = note.value.match(/([+-])(\d+(?:\.\d+)?)\%/g) || [];
    const pnlValues = pnlMatches.map((m) => parseFloat(m.replace("%", "")) / 100);

    const date = dateOnly(note.created_at);
    if (!dailyDecisions.has(date)) {
      dailyDecisions.set(date, []);
    }

    const decisions = dailyDecisions.get(date)!;
    let pnlIdx = 0;
    for (let i = 0; i < holdMatches; i++) {
      decisions.push({ action: "HOLD", pnl: pnlValues[pnlIdx++] });
    }
    for (let i = 0; i < rollMatches; i++) {
      decisions.push({ action: "ROLL", pnl: pnlValues[pnlIdx++] });
    }
    for (let i = 0; i < closeMatches; i++) {
      decisions.push({ action: "CLOSE", pnl: pnlValues[pnlIdx++] });
    }
    for (let i = 0; i < escalateMatches; i++) {
      decisions.push({ action: "ESCALATE", pnl: pnlValues[pnlIdx++] });
    }
  }

  for (const [date, decisions] of dailyDecisions.entries()) {
    if (decisions.length === 0) continue;

    const holdRollCount = decisions.filter((d) => d.action === "HOLD" || d.action === "ROLL").length;
    const winRate = holdRollCount / decisions.length;

    const pnlValues: number[] = decisions
      .filter((d): d is { action: string; pnl: number } => d.pnl !== undefined)
      .map((d) => d.pnl);
    const winners = pnlValues.filter((p) => p > 0);
    const losers = pnlValues.filter((p) => p < 0);

    const avgWinner = winners.length > 0 ? winners.reduce((a, b) => a + b, 0) / winners.length : 0;
    const avgLoser = losers.length > 0 ? losers.reduce((a, b) => a + b, 0) / losers.length : 0;

    const grossProfit = winners.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losers.reduce((a, b) => a + b, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

    const targetHits = decisions.filter((d) => d.pnl !== undefined && d.pnl >= 1.8).length;
    const opportunityCapture = targetHits / decisions.length;

    const metrics: MetricDef[] = [
      { name: "win_rate", value: winRate, target: 0.5 },
      { name: "avg_winner", value: avgWinner, target: 0.5 },
      { name: "avg_loser", value: avgLoser, target: -0.2 },
      { name: "profit_factor", value: profitFactor, target: 2.0 },
      { name: "opportunity_capture", value: opportunityCapture, target: 0.7 },
    ];

    const now = new Date().toISOString();
    for (const metric of metrics) {
      const status = statusFor(metric.value, metric.target);
      await run(
        db,
        `INSERT INTO trade_decision_quality_metrics
         (id, date, agent_id, metric_name, value, target_threshold, status, calculation_notes, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(date, agent_id, metric_name) DO UPDATE SET value=?, status=?, updated_at=?`,
        [
          crypto.randomUUID(),
          date,
          agentId,
          metric.name,
          metric.value,
          metric.target,
          status,
          `Backfilled from agent_notes; ${decisions.length} decisions analyzed`,
          now,
          metric.value,
          status,
          now,
        ],
      );
    }
  }

  console.log(`[metrics-backfill] Backfilled metrics for ${dailyDecisions.size} days`);
}

/**
 * Calculate current metrics from position_snapshots (used by scheduled cron).
 */
export async function calculateMetrics(
  db: D1Database,
  agentId: string = "agent-finance-lead",
  daysBack: number = 30,
): Promise<void> {
  const now = new Date().toISOString();

  const snapshots = await query<SnapshotRow>(
    db,
    `SELECT symbol, policy_decision, current_pnl_pct, days_to_expiry, created_at
     FROM position_snapshots
     WHERE agent_id = ? AND created_at >= datetime('now', ?)
     ORDER BY created_at DESC`,
    [agentId, `-${daysBack} days`],
  );

  if (snapshots.length === 0) {
    console.log("[metrics] No snapshots found for calculation");
    return;
  }

  const holdCount = snapshots.filter((s) => s.policy_decision === "HOLD").length;
  const rollCount = snapshots.filter((s) => s.policy_decision === "ROLL").length;
  const totalCount = snapshots.length;
  const winRate = (holdCount + rollCount) / totalCount;

  const closedSnapshots = snapshots.filter(
    (s) => s.policy_decision === "CLOSE" && Math.abs(s.current_pnl_pct) > 0,
  );
  const pnlValues = closedSnapshots.map((s) => s.current_pnl_pct);
  const winners = pnlValues.filter((p) => p > 0);
  const losers = pnlValues.filter((p) => p < 0);

  const avgWinner = winners.length > 0 ? winners.reduce((a, b) => a + b, 0) / winners.length : 0;
  const avgLoser = losers.length > 0 ? losers.reduce((a, b) => a + b, 0) / losers.length : 0;

  const grossProfit = winners.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losers.reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

  const targetHits = snapshots.filter((s) => s.current_pnl_pct >= 1.8).length;
  const opportunityCapture = totalCount > 0 ? targetHits / totalCount : 0;

  const today = dateOnly(now);
  const metrics: MetricDef[] = [
    { name: "win_rate", value: winRate, target: 0.5 },
    { name: "avg_winner", value: avgWinner, target: 0.5 },
    { name: "avg_loser", value: avgLoser, target: -0.2 },
    { name: "profit_factor", value: profitFactor, target: 2.0 },
    { name: "opportunity_capture", value: opportunityCapture, target: 0.7 },
  ];

  for (const metric of metrics) {
    const status = statusFor(metric.value, metric.target);
    await run(
      db,
      `INSERT INTO trade_decision_quality_metrics
       (id, date, agent_id, metric_name, value, target_threshold, status, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date, agent_id, metric_name) DO UPDATE SET value=?, status=?, updated_at=?`,
      [
        crypto.randomUUID(),
        today,
        agentId,
        metric.name,
        metric.value,
        metric.target,
        status,
        now,
        metric.value,
        status,
        now,
      ],
    );
  }

  console.log(`[metrics] Calculated metrics for ${totalCount} snapshots`);
}
