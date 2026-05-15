/**
 * A.12 — Daily Finance-Intel Progress Report.
 *
 * Read-only D1 probes + one Telegram send + one events.kind='progress.report_sent' row.
 * Phase classification is deterministic: only table/column existence, feature flags,
 * row counts, and recent event kinds. No prose, no LLM, no mutation of feedback rows.
 *
 * Reads: sqlite_master, agent_notes, position_snapshots, watchlist_snapshots,
 *        recommendation_feedback (when present), trade_decision_quality_metrics,
 *        events, tws_watchlist.
 * Writes: events (one row per fire, kind='progress.report_sent').
 * Forbidden: anything outside the above.
 */

import { query, queryOne, run } from "../db/schema";
import { sendDedupedTelegram } from "./telegram-dedup";

// ── Snapshot shape (pure data; classifier is pure over this) ─────────────────

export type Stage =
  | "LIVE"
  | "MERGED_OFF"
  | "READY_TO_FLIP"
  | "DATA_WAIT"
  | "NOT_STARTED"
  | "UNKNOWN";

export interface ProgressSnapshot {
  // A.6 readiness
  position_snapshots_table_exists: boolean;
  implied_volatility_column_exists: boolean;
  enriched_days_distinct: number;     // distinct days with non-NULL implied_volatility, last 30 days
  watchlist_snapshots_table_exists: boolean;
  last_eod: {
    date: string | null;             // YYYY-MM-DD of most recent snapshot day
    total: number;
    enriched: number;
    failed: number;
  } | null;
  last_watchlist: {
    recorded: number;
    expected: number;                // tws_watchlist where active=1
  } | null;

  // A.7 / A.8 / A.9 / A.10 flag state
  flag_greeks_enrichment: boolean;
  flag_probability_engine: boolean;
  flag_candidates: boolean;
  flag_recommendation_brief: boolean;
  flag_calibration_proposals: boolean;
  flag_progress_report: boolean;

  // A.9 / A.10 readiness
  recommendation_feedback_table_exists: boolean;
  approved_executed_outcomes: number;          // decision='approved' AND realized_outcome_json IS NOT NULL

  // A.11 readiness
  schwab_heartbeat_recent: boolean;            // any events.kind='schwab.heartbeat' in last 12h

  // Metrics (most recent row for any metric)
  latest_metrics: {
    date: string;
    win_rate?: number | null;
    profit_factor?: number | null;
    avg_winner?: number | null;
    statuses: string[];                        // distinct status values across metrics that day
  } | null;

  // Events digest
  error_event_kinds_24h: Array<{ kind: string; n: number }>;

  // Operator targets
  progress_targets: Record<string, string> | null;

  // Probe failures (so the renderer can say "unknown" instead of lying)
  probe_failures: string[];
}

export interface PhaseClassification {
  phase: "A.5" | "A.6" | "A.7" | "A.8" | "A.9" | "A.10" | "A.11" | "A.12";
  stage: Stage;
  detail?: string;
}

export interface PaceInfo {
  active_phase: string | null;
  pace: "on_pace" | "at_risk" | "behind" | "data_gated" | "target_unset" | "all_live";
  days_diff: number | null;   // negative = behind target; positive = ahead
  reason: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const ENRICHED_DAYS_REQUIRED_FOR_A7 = 7;
const OUTCOMES_REQUIRED_FOR_A10 = 14;

// ── Probe orchestration (defensive: every probe wrapped in try/catch) ────────

async function probeTable(db: D1Database, name: string): Promise<boolean> {
  const row = await queryOne<{ name: string }>(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1",
    [name],
  );
  return !!row;
}

async function probeColumn(db: D1Database, table: string, col: string): Promise<boolean> {
  const rows = await query<{ name: string }>(
    db,
    `SELECT name FROM pragma_table_info(?) WHERE name = ? LIMIT 1`,
    [table, col],
  );
  return rows.length > 0;
}

async function readFeatureFlag(db: D1Database, agentId: string, flag: string): Promise<boolean> {
  const row = await queryOne<{ value: string }>(
    db,
    "SELECT value FROM agent_notes WHERE agent_id = ? AND key = 'feature_flags_json' LIMIT 1",
    [agentId],
  );
  if (!row?.value) return false;
  try {
    const flags = JSON.parse(row.value) as Record<string, unknown>;
    return flags[flag] === true;
  } catch {
    return false;
  }
}

async function readProgressTargets(db: D1Database, agentId: string): Promise<Record<string, string> | null> {
  const row = await queryOne<{ value: string }>(
    db,
    "SELECT value FROM agent_notes WHERE agent_id = ? AND key = 'progress_targets_json' LIMIT 1",
    [agentId],
  );
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as Record<string, string>;
  } catch {
    return null;
  }
}

/**
 * Gather a ProgressSnapshot from D1. Every probe is wrapped so a missing table
 * or one bad query never crashes the cron. Failed probes are recorded by name.
 */
export async function gatherProgressSnapshot(db: D1Database, agentId: string): Promise<ProgressSnapshot> {
  const failures: string[] = [];
  const safe = async <T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (err) {
      failures.push(name);
      console.warn(`[progress-report] probe '${name}' failed:`, err);
      return fallback;
    }
  };

  const position_snapshots_table_exists = await safe("position_snapshots_table_exists",
    () => probeTable(db, "position_snapshots"), false);

  const implied_volatility_column_exists = position_snapshots_table_exists
    ? await safe("implied_volatility_column_exists",
        () => probeColumn(db, "position_snapshots", "implied_volatility"), false)
    : false;

  const watchlist_snapshots_table_exists = await safe("watchlist_snapshots_table_exists",
    () => probeTable(db, "watchlist_snapshots"), false);

  const recommendation_feedback_table_exists = await safe("recommendation_feedback_table_exists",
    () => probeTable(db, "recommendation_feedback"), false);

  const enriched_days_distinct = implied_volatility_column_exists
    ? await safe("enriched_days_distinct", async () => {
        const row = await queryOne<{ n: number }>(
          db,
          `SELECT COUNT(DISTINCT date(created_at)) AS n
           FROM position_snapshots
           WHERE implied_volatility IS NOT NULL
             AND created_at >= datetime('now','-30 days')`,
          [],
        );
        return row?.n ?? 0;
      }, 0)
    : 0;

  const last_eod = position_snapshots_table_exists
    ? await safe("last_eod", async () => {
        const dayRow = await queryOne<{ d: string }>(
          db,
          `SELECT date(MAX(created_at)) AS d FROM position_snapshots WHERE agent_id = ?`,
          [agentId],
        );
        const d = dayRow?.d;
        if (!d) return null;
        // Greeks columns may not exist yet (pre-A.6). Use COALESCE-style logic at query time.
        if (implied_volatility_column_exists) {
          const stats = await queryOne<{ total: number; enriched: number; failed: number }>(
            db,
            `SELECT
               COUNT(*) AS total,
               SUM(CASE WHEN enrichment_method='schwab_chain' THEN 1 ELSE 0 END) AS enriched,
               SUM(COALESCE(enrichment_failed,0)) AS failed
             FROM position_snapshots
             WHERE agent_id=? AND date(created_at)=?`,
            [agentId, d],
          );
          return { date: d, total: stats?.total ?? 0, enriched: stats?.enriched ?? 0, failed: stats?.failed ?? 0 };
        }
        const total = await queryOne<{ n: number }>(
          db,
          `SELECT COUNT(*) AS n FROM position_snapshots WHERE agent_id=? AND date(created_at)=?`,
          [agentId, d],
        );
        return { date: d, total: total?.n ?? 0, enriched: 0, failed: 0 };
      }, null)
    : null;

  const last_watchlist = watchlist_snapshots_table_exists
    ? await safe("last_watchlist", async () => {
        const r = await queryOne<{ recorded: number }>(
          db,
          `SELECT COUNT(DISTINCT symbol) AS recorded
           FROM watchlist_snapshots
           WHERE date(recorded_at) = (SELECT date(MAX(recorded_at)) FROM watchlist_snapshots)`,
          [],
        );
        const e = await queryOne<{ n: number }>(
          db,
          `SELECT COUNT(*) AS n FROM tws_watchlist WHERE active=1`,
          [],
        );
        return { recorded: r?.recorded ?? 0, expected: e?.n ?? 0 };
      }, null)
    : null;

  const flag_greeks_enrichment = await safe("flag_greeks_enrichment",
    () => readFeatureFlag(db, agentId, "enable_greeks_enrichment"), false);
  const flag_probability_engine = await safe("flag_probability_engine",
    () => readFeatureFlag(db, agentId, "enable_probability_engine"), false);
  const flag_candidates = await safe("flag_candidates",
    () => readFeatureFlag(db, agentId, "enable_candidates"), false);
  const flag_recommendation_brief = await safe("flag_recommendation_brief",
    () => readFeatureFlag(db, agentId, "enable_recommendation_brief"), false);
  const flag_calibration_proposals = await safe("flag_calibration_proposals",
    () => readFeatureFlag(db, agentId, "enable_calibration_proposals"), false);
  const flag_progress_report = await safe("flag_progress_report",
    () => readFeatureFlag(db, agentId, "enable_progress_report"), false);

  const approved_executed_outcomes = recommendation_feedback_table_exists
    ? await safe("approved_executed_outcomes", async () => {
        const r = await queryOne<{ n: number }>(
          db,
          `SELECT COUNT(*) AS n FROM recommendation_feedback
           WHERE decision='approved' AND outcome_attributed_at IS NOT NULL`,
          [],
        );
        return r?.n ?? 0;
      }, 0)
    : 0;

  const schwab_heartbeat_recent = await safe("schwab_heartbeat_recent", async () => {
    const r = await queryOne<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM events
       WHERE kind='schwab.heartbeat' AND created_at >= datetime('now','-12 hours')`,
      [],
    );
    return (r?.n ?? 0) > 0;
  }, false);

  const latest_metrics = await safe("latest_metrics", async () => {
    const dayRow = await queryOne<{ d: string }>(
      db,
      `SELECT MAX(date) AS d FROM trade_decision_quality_metrics WHERE agent_id=?`,
      [agentId],
    );
    const d = dayRow?.d;
    if (!d) return null;
    const rows = await query<{ metric_name: string; value: number; status: string }>(
      db,
      `SELECT metric_name, value, status
       FROM trade_decision_quality_metrics
       WHERE agent_id=? AND date=?`,
      [agentId, d],
    );
    const find = (name: string) => rows.find((r) => r.metric_name === name)?.value ?? null;
    return {
      date: d,
      win_rate: find("win_rate"),
      profit_factor: find("profit_factor"),
      avg_winner: find("avg_winner"),
      statuses: [...new Set(rows.map((r) => r.status))],
    };
  }, null);

  const error_event_kinds_24h = await safe("error_event_kinds_24h", async () => {
    const rows = await query<{ kind: string; n: number }>(
      db,
      `SELECT kind, COUNT(*) AS n FROM events
       WHERE created_at >= datetime('now','-24 hours')
         AND (kind LIKE 'enrichment.%failure%'
              OR kind LIKE 'enrichment.match_missing'
              OR kind LIKE '%failed%'
              OR kind LIKE '%error%')
       GROUP BY kind
       ORDER BY n DESC
       LIMIT 5`,
      [],
    );
    return rows.map((r) => ({ kind: r.kind, n: r.n }));
  }, []);

  const progress_targets = await safe("progress_targets",
    () => readProgressTargets(db, agentId), null);

  return {
    position_snapshots_table_exists,
    implied_volatility_column_exists,
    enriched_days_distinct,
    watchlist_snapshots_table_exists,
    last_eod,
    last_watchlist,
    flag_greeks_enrichment,
    flag_probability_engine,
    flag_candidates,
    flag_recommendation_brief,
    flag_calibration_proposals,
    flag_progress_report,
    recommendation_feedback_table_exists,
    approved_executed_outcomes,
    schwab_heartbeat_recent,
    latest_metrics,
    error_event_kinds_24h,
    progress_targets,
    probe_failures: failures,
  };
}

// ── Pure classifier (no I/O; used by both runtime and tests) ─────────────────

export function classifyPhases(s: ProgressSnapshot): PhaseClassification[] {
  const out: PhaseClassification[] = [];

  // A.5 — alive whenever the snapshot pipeline produced any recent row.
  if (s.position_snapshots_table_exists && s.last_eod && s.last_eod.total > 0) {
    out.push({ phase: "A.5", stage: "LIVE" });
  } else if (s.position_snapshots_table_exists) {
    out.push({ phase: "A.5", stage: "MERGED_OFF", detail: "no recent EOD row" });
  } else {
    out.push({ phase: "A.5", stage: "NOT_STARTED" });
  }

  // A.6 — column exists AND recent row has non-NULL IV.
  if (!s.implied_volatility_column_exists) {
    out.push({ phase: "A.6", stage: "NOT_STARTED" });
  } else if (!s.flag_greeks_enrichment) {
    out.push({ phase: "A.6", stage: "MERGED_OFF", detail: "flag off" });
  } else if (s.enriched_days_distinct >= 1) {
    out.push({ phase: "A.6", stage: "LIVE", detail: `${s.enriched_days_distinct} enriched days` });
  } else {
    out.push({ phase: "A.6", stage: "MERGED_OFF", detail: "flag on but no enriched rows yet" });
  }

  const a6Live = out[out.length - 1]?.stage === "LIVE";

  // A.7 — needs A.6 LIVE + ≥7 enriched days OR flag already on.
  if (s.flag_probability_engine) {
    out.push({ phase: "A.7", stage: "LIVE" });
  } else if (a6Live && s.enriched_days_distinct >= ENRICHED_DAYS_REQUIRED_FOR_A7) {
    out.push({ phase: "A.7", stage: "READY_TO_FLIP", detail: `${s.enriched_days_distinct} enriched days` });
  } else if (a6Live) {
    out.push({
      phase: "A.7",
      stage: "DATA_WAIT",
      detail: `${s.enriched_days_distinct}/${ENRICHED_DAYS_REQUIRED_FOR_A7} enriched days`,
    });
  } else {
    out.push({ phase: "A.7", stage: "NOT_STARTED" });
  }

  const a7Live = out[out.length - 1]?.stage === "LIVE";

  // A.8 — needs A.7 LIVE.
  if (s.flag_candidates) {
    out.push({ phase: "A.8", stage: "LIVE" });
  } else if (a7Live) {
    out.push({ phase: "A.8", stage: "READY_TO_FLIP" });
  } else {
    out.push({ phase: "A.8", stage: "NOT_STARTED" });
  }

  const a8Live = out[out.length - 1]?.stage === "LIVE";

  // A.9 — needs A.8 LIVE AND recommendation_feedback table exists.
  if (s.flag_recommendation_brief && s.recommendation_feedback_table_exists) {
    out.push({ phase: "A.9", stage: "LIVE" });
  } else if (a8Live && s.recommendation_feedback_table_exists) {
    out.push({ phase: "A.9", stage: "READY_TO_FLIP" });
  } else {
    out.push({ phase: "A.9", stage: "NOT_STARTED" });
  }

  const a9Live = out[out.length - 1]?.stage === "LIVE";

  // A.10 — needs ≥14 approved+executed outcomes.
  if (s.flag_calibration_proposals && s.approved_executed_outcomes >= OUTCOMES_REQUIRED_FOR_A10) {
    out.push({ phase: "A.10", stage: "LIVE" });
  } else if (a9Live && s.approved_executed_outcomes >= OUTCOMES_REQUIRED_FOR_A10) {
    out.push({ phase: "A.10", stage: "READY_TO_FLIP", detail: `${s.approved_executed_outcomes} outcomes` });
  } else if (a9Live) {
    out.push({
      phase: "A.10",
      stage: "DATA_WAIT",
      detail: `${s.approved_executed_outcomes}/${OUTCOMES_REQUIRED_FOR_A10} outcomes`,
    });
  } else {
    out.push({ phase: "A.10", stage: "NOT_STARTED" });
  }

  // A.11 — operational; LIVE when we see a heartbeat event in last 12h.
  if (s.schwab_heartbeat_recent) {
    out.push({ phase: "A.11", stage: "LIVE" });
  } else {
    out.push({ phase: "A.11", stage: "NOT_STARTED" });
  }

  // A.12 (self) — LIVE when the flag is on (since this very code is running).
  out.push({ phase: "A.12", stage: s.flag_progress_report ? "LIVE" : "MERGED_OFF" });

  return out;
}

// ── Pace logic ──────────────────────────────────────────────────────────────

function targetKey(phase: string): string {
  // Convert "A.7" → "a7_target_date"
  return `${phase.toLowerCase().replace(".", "")}_target_date`;
}

export function computePace(classification: PhaseClassification[], targets: Record<string, string> | null, today: string): PaceInfo {
  // Active phase = first phase not LIVE (in spec order).
  const order = ["A.5", "A.6", "A.7", "A.8", "A.9", "A.10"];
  const active = classification.find((c) => order.includes(c.phase) && c.stage !== "LIVE");
  if (!active) {
    return { active_phase: null, pace: "all_live", days_diff: null, reason: "all required phases live" };
  }
  if (active.stage === "DATA_WAIT") {
    return {
      active_phase: active.phase,
      pace: "data_gated",
      days_diff: null,
      reason: active.detail ?? "data accumulating",
    };
  }
  const key = targetKey(active.phase);
  const target = targets?.[key];
  if (!target) {
    return { active_phase: active.phase, pace: "target_unset", days_diff: null, reason: "no target date set" };
  }
  const days = Math.floor((Date.parse(today) - Date.parse(target)) / 86_400_000);
  const pace: PaceInfo["pace"] =
    days <= 2 ? "on_pace" : days <= 7 ? "at_risk" : "behind";
  return {
    active_phase: active.phase,
    pace,
    days_diff: days,
    reason: `target ${target}`,
  };
}

// ── "Use today" lookup table (deterministic; not prose) ──────────────────────

function useTodayBullets(highestLive: string): string[] {
  const table: Record<string, string[]> = {
    "A.5": [
      "Query <code>position_snapshots</code> for yesterday's decisions and rationale.",
      "Review <code>trade_decision_quality_metrics</code> for drift vs targets.",
    ],
    "A.6": [
      "Inspect Greeks/IV trends: <code>SELECT date(created_at), implied_volatility FROM position_snapshots WHERE symbol='GOOGL' ORDER BY created_at DESC LIMIT 7</code>.",
      "Confirm watchlist coverage: <code>SELECT COUNT(DISTINCT symbol) FROM watchlist_snapshots WHERE date(recorded_at)=date('now')</code>.",
    ],
    "A.7": ["Probability checks available for any held symbol's target."],
    "A.8": ["EOD brief now includes ranked candidates (review-only until A.9)."],
    "A.9": ["Approve / reject trade recommendations directly in Telegram."],
    "A.10": ["Watch for Sunday-night threshold calibration proposals."],
  };
  return table[highestLive] ?? ["Phase A.5 only — system in audit-only mode."];
}

// ── Renderer ────────────────────────────────────────────────────────────────

export function formatProgressReport(
  classification: PhaseClassification[],
  pace: PaceInfo,
  snap: ProgressSnapshot,
  today: string,
): string {
  const live = classification.filter((c) => c.stage === "LIVE").map((c) => c.phase);
  const waiting = classification.filter((c) => c.stage === "DATA_WAIT" || c.stage === "NOT_STARTED").map((c) => c.phase);
  const active = classification.find((c) => c.phase === pace.active_phase);

  const highestLive = live.includes("A.10") ? "A.10"
    : live.includes("A.9") ? "A.9"
    : live.includes("A.8") ? "A.8"
    : live.includes("A.7") ? "A.7"
    : live.includes("A.6") ? "A.6"
    : "A.5";

  const lines: string[] = [];
  lines.push(`📊 <b>Finance-Intel Progress · ${today}</b>`);
  lines.push("");
  lines.push(`✅ <b>Live:</b> ${live.length ? live.join(", ") : "(none)"}`);

  if (active) {
    lines.push(`🚧 <b>Active:</b> ${active.phase} — ${active.stage}${active.detail ? ` (${active.detail})` : ""}`);
  }
  if (waiting.length) {
    lines.push(`⏸ <b>Waiting:</b> ${waiting.join(", ")}`);
  }

  // Pace
  if (pace.pace === "all_live") {
    lines.push(`<b>Pace:</b> all phases live`);
  } else if (pace.pace === "data_gated") {
    lines.push(`<b>Pace:</b> data-gated · ${pace.reason}`);
  } else if (pace.pace === "target_unset") {
    lines.push(`<b>Pace:</b> target_unset`);
  } else {
    const dir = (pace.days_diff ?? 0) >= 0 ? "behind" : "ahead";
    lines.push(`<b>Pace:</b> ${pace.pace} · ${Math.abs(pace.days_diff ?? 0)}d ${dir} (${pace.reason})`);
  }

  // Last EOD
  if (snap.last_eod) {
    const e = snap.last_eod;
    lines.push(`<b>Last EOD (${e.date}):</b> ${e.enriched}/${e.total} enriched${e.failed ? `, ${e.failed} failed` : ""}`);
  } else {
    lines.push(`<b>Last EOD:</b> none yet`);
  }

  // Watchlist
  if (snap.last_watchlist) {
    lines.push(`<b>Watchlist:</b> ${snap.last_watchlist.recorded}/${snap.last_watchlist.expected} symbols recorded`);
  }

  // Metrics
  if (snap.latest_metrics) {
    const m = snap.latest_metrics;
    const winPct = m.win_rate != null ? `${Math.round(m.win_rate * 100)}%` : "—";
    const pf = m.profit_factor != null ? m.profit_factor.toFixed(1) : "—";
    lines.push(`<b>Metrics (${m.date}):</b> win ${winPct} · PF ${pf} · ${m.statuses.join("/")}`);
  }

  // 24h errors
  if (snap.error_event_kinds_24h.length > 0) {
    const summary = snap.error_event_kinds_24h.map((e) => `${e.kind}×${e.n}`).join(", ");
    lines.push(`<b>24h events:</b> ${summary}`);
  }

  // Probe failures
  if (snap.probe_failures.length > 0) {
    lines.push(`<i>(unknown: ${snap.probe_failures.join(", ")})</i>`);
  }

  // Use today
  lines.push("");
  lines.push("<b>Use today:</b>");
  for (const b of useTodayBullets(highestLive)) {
    lines.push(`• ${b}`);
  }

  return lines.join("\n");
}

// ── Public entry points ──────────────────────────────────────────────────────

/** Pure-ish: builds the snapshot and returns the rendered HTML + classification. */
export async function generateProgressReport(
  db: D1Database,
  agentId: string = "agent-finance-lead",
  today?: string,
): Promise<{ html: string; classification: PhaseClassification[]; pace: PaceInfo; snapshot: ProgressSnapshot }> {
  const snap = await gatherProgressSnapshot(db, agentId);
  const classification = classifyPhases(snap);
  const todayIso = today ?? new Date().toISOString().slice(0, 10);
  const pace = computePace(classification, snap.progress_targets, todayIso);
  const html = formatProgressReport(classification, pace, snap, todayIso);
  return { html, classification, pace, snapshot: snap };
}

/**
 * Side-effectful: sends the daily Telegram report and writes one events row.
 * Gated by env.TELEGRAM_BOT_TOKEN + env.TELEGRAM_CHAT_ID; no-op if missing.
 */
export async function sendProgressReport(env: {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
}): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.warn("[progress-report] Telegram bot token / chat id missing; skipping send");
    return;
  }
  const { html } = await generateProgressReport(env.DB);
  const now = new Date().toISOString();
  await sendDedupedTelegram(
    { DB: env.DB, TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN },
    {
      chatId: env.TELEGRAM_CHAT_ID,
      routeType: "progress_report_daily",
      text: html,
      parseMode: "HTML",
    },
  );
  await run(
    env.DB,
    `INSERT INTO events (id, kind, actor_id, target_kind, target_id, payload, session_id, created_at, updated_at)
     VALUES (?, 'progress.report_sent', 'scheduler', 'system', 'progress-report', ?, NULL, ?, ?)`,
    [crypto.randomUUID(), JSON.stringify({ length: html.length }), now, now],
  );
}
