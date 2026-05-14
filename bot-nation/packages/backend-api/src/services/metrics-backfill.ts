/**
 * Metrics Backfill Service
 *
 * Extracts 30 days of historical trade decisions from agent_notes
 * and seeds the trade_decision_quality_metrics table on first deployment.
 *
 * Called once during migration 0043 deployment, or manually via /task.
 * Enables day-1 feedback loop without waiting 30 days for natural history.
 */

import { run, query, queryOne } from "../db/schema";

export interface MetricsSnapshot {
  date: string;
  win_rate: number;
  avg_winner: number;
  avg_loser: number;
  profit_factor: number;
  opportunity_capture: number;
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
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - daysBack * 86400000);

  // Query agent_notes for all entries with decision patterns in past 30 days
  const notes = await query<{ key: string; value: string; created_at: string }>(
    db,
    `SELECT key, value, created_at FROM agent_notes
     WHERE agent_id = ? AND created_at >= datetime('now', ?)
     ORDER BY created_at DESC`,
    [agentId, `-${daysBack} days`],
  );

  // Parse historical decisions from notes (regex patterns)
  const dailyDecisions: Map<string, Array<{ action: string; pnl?: number }>> = new Map();

  for (const note of notes) {
    // Extract decision patterns: "HOLD", "ROLL", "CLOSE", "ESCALATE"
    const holdMatches = (note.value.match(/HOLD/gi) || []).length;
    const rollMatches = (note.value.match(/ROLL/gi) || []).length;
    const closeMatches = (note.value.match(/CLOSE/gi) || []).length;
    const escalateMatches = (note.value.match(/ESCALATE/gi) || []).length;

    // Extract P&L values: "+50%", "-20%", "+180%", etc.
    const pnlMatches = note.value.match(/([+-])(\d+(?:\.\d+)?)\%/g) || [];
    const pnlValues = pnlMatches.map((m) => {
      const parsed = parseFloat(m.replace("%", "")) / 100;
      return parsed;
    });

    // Group by date
    const date = new Date(note.created_at).toISOString().split("T")[0];
    if (!dailyDecisions.has(date)) {
      dailyDecisions.set(date, []);
    }

    const decisions = dailyDecisions.get(date)!;
    for (let i = 0; i < holdMatches; i++) {
      decisions.push({ action: "HOLD", pnl: pnlValues[i] });
    }
    for (let i = 0; i < rollMatches; i++) {
      decisions.push({ action: "ROLL", pnl: pnlValues[holdMatches + i] });
    }
    for (let i = 0; i < closeMatches; i++) {
      decisions.push({ action: "CLOSE", pnl: pnlValues[holdMatches + rollMatches + i] });
    }
    for (let i = 0; i < escalateMatches; i++) {
      decisions.push({ action: "ESCALATE", pnl: pnlValues[holdMatches + rollMatches + closeMatches + i] });
    }
  }

  // Calculate daily metrics
  for (const [date, decisions] of dailyDecisions.entries()) {
    if (decisions.length === 0) continue;

    // Win rate: HOLD + ROLL / total
    const holdRollCount = decisions.filter((d) => d.action === "HOLD" || d.action === "ROLL").length;
    const winRate = decisions.length > 0 ? holdRollCount / decisions.length : 0;

    // P&L-based metrics
    const pnlValues = decisions.filter((d) => d.pnl !== undefined).map((d) => d.pnl!);
    const winners = pnlValues.filter((p) => p > 0);
    const losers = pnlValues.filter((p) => p < 0);

    const avgWinner = winners.length > 0 ? winners.reduce((a, b) => a + b) / winners.length : 0;
    const avgLoser = losers.length > 0 ? losers.reduce((a, b) => a + b) / losers.length : 0;

    const grossProfit = winners.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(losers.reduce((a, b) => a + b, 0));
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

    // Opportunity capture: decisions that hit target / total
    const targetHits = decisions.filter((d) => d.pnl && d.pnl >= 1.8).length;
    const opportunityCapture = decisions.length > 0 ? targetHits / decisions.length : 0;

    // Insert metrics for this date
    const metrics = [
      { name: "win_rate", value: winRate, target: 0.5 },
      { name: "avg_winner", value: avgWinner, target: 0.5 },
      { name: "avg_loser", value: avgLoser, target: -0.2 },
      { name: "profit_factor", value: profitFactor, target: 2.0 },
      { name: "opportunity_capture", value: opportunityCapture, target: 0.7 },
    ];

    for (const metric of metrics) {
      const status =
        metric.name === "avg_loser"
          ? value => (value >= metric.target ? "on_target" : "below_target")
          : metric.name === "win_rate" || metric.name === "opportunity_capture"
            ? (value) => (value >= metric.target ? "on_target" : "below_target")
            : (value) => (value >= metric.target ? "on_target" : "below_target");

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
          status(metric.value),
          `Backfilled from agent_notes; ${decisions.length} decisions analyzed`,
          new Date().toISOString(),
          // Duplicate for ON CONFLICT clause
          metric.value,
          status(metric.value),
          new Date().toISOString(),
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

  // Fetch position snapshots from past N days
  const snapshots = await query(
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

  // Group by decision type
  const holdCount = snapshots.filter((s) => s.policy_decision === "HOLD").length;
  const rollCount = snapshots.filter((s) => s.policy_decision === "ROLL").length;
  const closeCount = snapshots.filter((s) => s.policy_decision === "CLOSE").length;
  const escalateCount = snapshots.filter((s) => s.policy_decision === "ESCALATE").length;
  const totalCount = snapshots.length;

  // Win rate: HOLD + ROLL / total
  const winRate = (holdCount + rollCount) / totalCount;

  // P&L metrics (from closed positions)
  const closedSnapshots = snapshots.filter(
    (s) => s.policy_decision === "CLOSE" && Math.abs(s.current_pnl_pct) > 0,
  );
  const pnlValues = closedSnapshots.map((s) => s.current_pnl_pct);
  const winners = pnlValues.filter((p) => p > 0);
  const losers = pnlValues.filter((p) => p < 0);

  const avgWinner = winners.length > 0 ? winners.reduce((a, b) => a + b) / winners.length : 0;
  const avgLoser = losers.length > 0 ? losers.reduce((a, b) => a + b) / losers.length : 0;

  // Sum all profits and losses (not max/min)
  const grossProfit = winners.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losers.reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

  // Opportunity capture: snapshots with P&L >= 180% / total eligible
  const targetHits = snapshots.filter((s) => s.current_pnl_pct >= 1.8).length;
  const opportunityCapture = totalCount > 0 ? targetHits / totalCount : 0;

  // Insert/update metrics for today
  const today = new Date().toISOString().split("T")[0];
  const metrics = [
    { name: "win_rate", value: winRate, target: 0.5 },
    { name: "avg_winner", value: avgWinner, target: 0.5 },
    { name: "avg_loser", value: avgLoser, target: -0.2 },
    { name: "profit_factor", value: profitFactor, target: 2.0 },
    { name: "opportunity_capture", value: opportunityCapture, target: 0.7 },
  ];

  for (const metric of metrics) {
    // For avg_loser, higher values (closer to 0) are better
    // For all others, higher values are better
    const isOnTarget = metric.value >= metric.target;
    const status = isOnTarget ? "on_target" : "below_target";

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
