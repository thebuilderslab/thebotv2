/**
 * Unit tests for A.12 progress-report classifier and renderer.
 * Pure functions only — no D1 mocking. The orchestrator (`gatherProgressSnapshot`)
 * is exercised in integration; here we cover classification rules and rendering.
 */

import { describe, expect, it } from "vitest";
import {
  classifyPhases,
  computePace,
  formatProgressReport,
  type ProgressSnapshot,
} from "./progress-report";

function baseSnapshot(): ProgressSnapshot {
  return {
    position_snapshots_table_exists: false,
    implied_volatility_column_exists: false,
    enriched_days_distinct: 0,
    watchlist_snapshots_table_exists: false,
    last_eod: null,
    last_watchlist: null,
    flag_greeks_enrichment: false,
    flag_probability_engine: false,
    flag_candidates: false,
    flag_recommendation_brief: false,
    flag_calibration_proposals: false,
    flag_progress_report: false,
    recommendation_feedback_table_exists: false,
    approved_executed_outcomes: 0,
    schwab_heartbeat_recent: false,
    latest_metrics: null,
    error_event_kinds_24h: [],
    progress_targets: null,
    probe_failures: [],
  };
}

describe("classifyPhases — fresh deployment (no A.5 yet)", () => {
  it("reports every phase NOT_STARTED when no tables exist", () => {
    const snap = baseSnapshot();
    const c = classifyPhases(snap);
    const stages = Object.fromEntries(c.map((p) => [p.phase, p.stage]));
    expect(stages["A.5"]).toBe("NOT_STARTED");
    expect(stages["A.6"]).toBe("NOT_STARTED");
    expect(stages["A.7"]).toBe("NOT_STARTED");
    expect(stages["A.8"]).toBe("NOT_STARTED");
    expect(stages["A.9"]).toBe("NOT_STARTED");
    expect(stages["A.10"]).toBe("NOT_STARTED");
    expect(stages["A.11"]).toBe("NOT_STARTED");
    expect(stages["A.12"]).toBe("MERGED_OFF");
  });
});

describe("classifyPhases — A.5 live only", () => {
  it("marks A.5 LIVE and A.6 NOT_STARTED before A.6 column lands", () => {
    const snap = baseSnapshot();
    snap.position_snapshots_table_exists = true;
    snap.last_eod = { date: "2026-05-14", total: 6, enriched: 0, failed: 0 };
    const c = classifyPhases(snap);
    const stages = Object.fromEntries(c.map((p) => [p.phase, p.stage]));
    expect(stages["A.5"]).toBe("LIVE");
    expect(stages["A.6"]).toBe("NOT_STARTED");
    expect(stages["A.7"]).toBe("NOT_STARTED");
  });
});

describe("classifyPhases — A.6 column merged but flag off", () => {
  it("marks A.6 MERGED_OFF when implied_volatility column exists but flag is off", () => {
    const snap = baseSnapshot();
    snap.position_snapshots_table_exists = true;
    snap.implied_volatility_column_exists = true;
    snap.flag_greeks_enrichment = false;
    snap.last_eod = { date: "2026-05-14", total: 6, enriched: 0, failed: 0 };
    const c = classifyPhases(snap);
    expect(c.find((p) => p.phase === "A.6")?.stage).toBe("MERGED_OFF");
    expect(c.find((p) => p.phase === "A.7")?.stage).toBe("NOT_STARTED");
  });
});

describe("classifyPhases — A.6 flag on, 5 enriched days (data wait)", () => {
  it("marks A.7 DATA_WAIT with the correct day count", () => {
    const snap = baseSnapshot();
    snap.position_snapshots_table_exists = true;
    snap.implied_volatility_column_exists = true;
    snap.flag_greeks_enrichment = true;
    snap.enriched_days_distinct = 5;
    snap.last_eod = { date: "2026-05-14", total: 6, enriched: 6, failed: 0 };
    const c = classifyPhases(snap);
    expect(c.find((p) => p.phase === "A.6")?.stage).toBe("LIVE");
    const a7 = c.find((p) => p.phase === "A.7")!;
    expect(a7.stage).toBe("DATA_WAIT");
    expect(a7.detail).toBe("5/7 enriched days");
  });
});

describe("classifyPhases — A.6 flag on, ≥7 enriched days (ready to flip A.7)", () => {
  it("marks A.7 READY_TO_FLIP", () => {
    const snap = baseSnapshot();
    snap.position_snapshots_table_exists = true;
    snap.implied_volatility_column_exists = true;
    snap.flag_greeks_enrichment = true;
    snap.enriched_days_distinct = 8;
    snap.last_eod = { date: "2026-05-22", total: 6, enriched: 6, failed: 0 };
    const c = classifyPhases(snap);
    expect(c.find((p) => p.phase === "A.7")?.stage).toBe("READY_TO_FLIP");
  });
});

describe("classifyPhases — A.10 data-wait when A.9 live but outcomes thin", () => {
  it("marks A.10 DATA_WAIT with outcome count", () => {
    const snap = baseSnapshot();
    snap.position_snapshots_table_exists = true;
    snap.implied_volatility_column_exists = true;
    snap.flag_greeks_enrichment = true;
    snap.flag_probability_engine = true;
    snap.flag_candidates = true;
    snap.flag_recommendation_brief = true;
    snap.recommendation_feedback_table_exists = true;
    snap.enriched_days_distinct = 10;
    snap.approved_executed_outcomes = 3;
    snap.last_eod = { date: "2026-06-01", total: 6, enriched: 6, failed: 0 };
    const c = classifyPhases(snap);
    expect(c.find((p) => p.phase === "A.9")?.stage).toBe("LIVE");
    const a10 = c.find((p) => p.phase === "A.10")!;
    expect(a10.stage).toBe("DATA_WAIT");
    expect(a10.detail).toBe("3/14 outcomes");
  });
});

describe("classifyPhases — missing recommendation_feedback table does not crash A.10", () => {
  it("keeps A.10 NOT_STARTED when its table is absent, even with all earlier flags on", () => {
    const snap = baseSnapshot();
    snap.position_snapshots_table_exists = true;
    snap.implied_volatility_column_exists = true;
    snap.flag_greeks_enrichment = true;
    snap.flag_probability_engine = true;
    snap.flag_candidates = true;
    snap.flag_recommendation_brief = true;
    snap.recommendation_feedback_table_exists = false; // not yet migrated
    snap.enriched_days_distinct = 10;
    snap.last_eod = { date: "2026-06-01", total: 6, enriched: 6, failed: 0 };
    const c = classifyPhases(snap);
    // A.9 cannot be LIVE without its feedback table
    expect(c.find((p) => p.phase === "A.9")?.stage).toBe("NOT_STARTED");
    expect(c.find((p) => p.phase === "A.10")?.stage).toBe("NOT_STARTED");
  });
});

describe("classifyPhases — A.11 heartbeat probe", () => {
  it("marks A.11 LIVE when a recent heartbeat event exists", () => {
    const snap = baseSnapshot();
    snap.schwab_heartbeat_recent = true;
    const c = classifyPhases(snap);
    expect(c.find((p) => p.phase === "A.11")?.stage).toBe("LIVE");
  });
});

describe("computePace", () => {
  it("returns data_gated when active phase is in DATA_WAIT (overrides target_unset)", () => {
    const snap = baseSnapshot();
    snap.position_snapshots_table_exists = true;
    snap.implied_volatility_column_exists = true;
    snap.last_eod = { date: "2026-05-14", total: 6, enriched: 6, failed: 0 };
    snap.flag_greeks_enrichment = true;
    snap.enriched_days_distinct = 3; // A.6 LIVE; A.7 DATA_WAIT (3/7)
    const c = classifyPhases(snap);
    const pace = computePace(c, null, "2026-05-15");
    expect(pace.active_phase).toBe("A.7");
    expect(pace.pace).toBe("data_gated");
  });

  it("returns target_unset when active phase is NOT_STARTED and no targets configured", () => {
    const snap = baseSnapshot();
    snap.position_snapshots_table_exists = true;
    snap.last_eod = { date: "2026-05-14", total: 6, enriched: 0, failed: 0 };
    // A.6 NOT_STARTED (no column yet) — not DATA_WAIT → target_unset
    const c = classifyPhases(snap);
    const pace = computePace(c, null, "2026-05-15");
    expect(pace.active_phase).toBe("A.6");
    expect(pace.pace).toBe("target_unset");
  });

  it("returns on_pace when target is today and active is not DATA_WAIT", () => {
    const snap = baseSnapshot();
    snap.position_snapshots_table_exists = true;
    snap.last_eod = { date: "2026-05-14", total: 6, enriched: 0, failed: 0 };
    // A.6 NOT_STARTED → active = A.6
    const c = classifyPhases(snap);
    const targets = { a6_target_date: "2026-05-15" };
    const pace = computePace(c, targets, "2026-05-15");
    expect(pace.active_phase).toBe("A.6");
    expect(pace.pace).toBe("on_pace");
    expect(pace.days_diff).toBe(0);
  });

  it("returns behind when active phase is >7 days past target", () => {
    const snap = baseSnapshot();
    snap.position_snapshots_table_exists = true;
    snap.last_eod = { date: "2026-05-14", total: 6, enriched: 0, failed: 0 };
    const c = classifyPhases(snap);
    const pace = computePace(c, { a6_target_date: "2026-05-01" }, "2026-05-15");
    expect(pace.pace).toBe("behind");
    expect(pace.days_diff).toBe(14);
  });

  it("returns all_live when every required phase is LIVE", () => {
    const snap = baseSnapshot();
    snap.position_snapshots_table_exists = true;
    snap.implied_volatility_column_exists = true;
    snap.flag_greeks_enrichment = true;
    snap.flag_probability_engine = true;
    snap.flag_candidates = true;
    snap.flag_recommendation_brief = true;
    snap.flag_calibration_proposals = true;
    snap.recommendation_feedback_table_exists = true;
    snap.enriched_days_distinct = 30;
    snap.approved_executed_outcomes = 50;
    snap.last_eod = { date: "2026-07-01", total: 6, enriched: 6, failed: 0 };
    const c = classifyPhases(snap);
    const pace = computePace(c, null, "2026-07-02");
    expect(pace.pace).toBe("all_live");
  });
});

describe("formatProgressReport — output shape", () => {
  it("renders a Telegram-friendly HTML message with required sections", () => {
    const snap = baseSnapshot();
    snap.position_snapshots_table_exists = true;
    snap.implied_volatility_column_exists = true;
    snap.flag_greeks_enrichment = true;
    snap.enriched_days_distinct = 5;
    snap.last_eod = { date: "2026-05-14", total: 6, enriched: 6, failed: 0 };
    snap.last_watchlist = { recorded: 4, expected: 4 };
    snap.latest_metrics = {
      date: "2026-05-14", win_rate: 0.67, profit_factor: 2.4, avg_winner: 0.5, statuses: ["on_target"],
    };
    const c = classifyPhases(snap);
    const pace = computePace(c, null, "2026-05-15");
    const html = formatProgressReport(c, pace, snap, "2026-05-15");
    expect(html).toContain("📊 <b>Finance-Intel Progress · 2026-05-15</b>");
    expect(html).toContain("<b>Live:</b>");
    expect(html).toContain("<b>Active:</b> A.7 — DATA_WAIT");
    expect(html).toContain("<b>Last EOD (2026-05-14):</b> 6/6 enriched");
    expect(html).toContain("<b>Watchlist:</b> 4/4 symbols recorded");
    expect(html).toContain("win 67%");
    expect(html).toContain("PF 2.4");
    expect(html).toContain("<b>Use today:</b>");
    expect(html.length).toBeLessThanOrEqual(1500); // Telegram-friendly
  });

  it("includes probe-failure footer when probes failed", () => {
    const snap = baseSnapshot();
    snap.position_snapshots_table_exists = true;
    snap.last_eod = { date: "2026-05-14", total: 6, enriched: 0, failed: 0 };
    snap.probe_failures = ["latest_metrics", "watchlist_snapshots_table_exists"];
    const c = classifyPhases(snap);
    const pace = computePace(c, null, "2026-05-15");
    const html = formatProgressReport(c, pace, snap, "2026-05-15");
    expect(html).toContain("(unknown: latest_metrics, watchlist_snapshots_table_exists)");
  });

  it("never crashes when last_eod is null", () => {
    const snap = baseSnapshot();
    const c = classifyPhases(snap);
    const pace = computePace(c, null, "2026-05-15");
    const html = formatProgressReport(c, pace, snap, "2026-05-15");
    expect(html).toContain("<b>Last EOD:</b> none yet");
  });
});

describe("formatProgressReport — A.6 / A.7 readiness branch", () => {
  it("shows A.7 as READY_TO_FLIP with enriched day count", () => {
    const snap = baseSnapshot();
    snap.position_snapshots_table_exists = true;
    snap.implied_volatility_column_exists = true;
    snap.flag_greeks_enrichment = true;
    snap.enriched_days_distinct = 9;
    snap.last_eod = { date: "2026-05-22", total: 6, enriched: 6, failed: 0 };
    const c = classifyPhases(snap);
    const pace = computePace(c, null, "2026-05-23");
    const html = formatProgressReport(c, pace, snap, "2026-05-23");
    expect(html).toContain("A.7 — READY_TO_FLIP (9 enriched days)");
  });
});
