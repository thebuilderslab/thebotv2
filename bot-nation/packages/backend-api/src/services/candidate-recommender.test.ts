/**
 * Unit tests for the A.8 Candidate Recommender (Layer 4).
 *
 * Covers spec §A.8 acceptance criteria:
 *   - Every emitted candidate satisfies every hard filter.
 *   - Top-ranked > runner-up after tie-break.
 *   - All candidates have exactly 2 legs.
 *   - Equity-only positions return [].
 *   - Empty chain returns [].
 *   - Probability engine throw → that candidate scored with p_profit_30d = 0.5.
 *   - Structure variety: sufficient strikes produce ≥1 SINGLE_LEG and ≥1 DIAGONAL.
 *   - Tie-break: identical scores → higher credit, then lower delta, then earlier DTE.
 *
 * Plus §10 testing minimums: ≥1 unit test per exported function.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCORING_WEIGHTS,
  applyHardFilters,
  findNextExpiry,
  findStrikeOffset,
  generateDiagonalRolls,
  generateSingleLegRolls,
  recommendCandidates,
  tieBreak,
  type PositionForRecommendation,
  type RecommendationCandidate,
} from "./candidate-recommender";
import type { OptionContract, OptionsChainResult } from "./schwab-positions";
import type { PolicyThresholds } from "./policy-impact-model";
import type { ProbabilityEngine, ProbabilityResult } from "./probability-engine";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function call(strike: number, expiration: string, dte: number, opts: Partial<OptionContract> = {}): OptionContract {
  return {
    symbol: `GOOGL ${expiration.replace(/-/g, "").slice(2)}C${String(strike * 1000).padStart(8, "0")}`,
    strike,
    expiration,
    contract_type: "CALL",
    bid: opts.bid ?? Math.max(0.1, 10 - (strike - 340) * 1.5),
    ask: opts.ask ?? Math.max(0.2, 10 - (strike - 340) * 1.5 + 0.1),
    mark: opts.mark ?? Math.max(0.15, 10 - (strike - 340) * 1.5 + 0.05),
    last: opts.last ?? 0,
    delta: opts.delta ?? Math.max(0.05, 0.5 - (strike - 340) * 0.05),
    gamma: opts.gamma ?? 0.04,
    theta: opts.theta ?? -0.07,
    vega: opts.vega ?? 0.10,
    iv: opts.iv ?? 0.28,
    volume: opts.volume ?? 100,
    open_interest: opts.open_interest ?? 1000,
    in_the_money: opts.in_the_money ?? strike <= 336,
    dte,
  };
}

function chainGooglMay(): OptionsChainResult {
  // Two expiries: 2026-04-24 (current short, 8 dte), 2026-05-08 (diagonal target, 22 dte).
  return {
    symbol: "GOOGL",
    underlying_price: 335.70,
    as_of: "2026-05-15T20:30:00.000Z",
    calls: [
      // Current-expiry strikes
      call(340, "2026-04-24", 8, { bid: 4.30, ask: 4.40, mark: 4.35, delta: 0.42 }),
      call(345, "2026-04-24", 8, { bid: 2.10, ask: 2.20, mark: 2.15, delta: 0.27 }),
      call(350, "2026-04-24", 8, { bid: 1.05, ask: 1.15, mark: 1.10, delta: 0.18 }),
      call(355, "2026-04-24", 8, { bid: 0.50, ask: 0.60, mark: 0.55, delta: 0.10 }),
      call(360, "2026-04-24", 8, { bid: 0.20, ask: 0.30, mark: 0.25, delta: 0.05 }),
      call(365, "2026-04-24", 8, { bid: 0.10, ask: 0.20, mark: 0.15, delta: 0.03 }),
      // New-expiry strikes (diagonal target)
      call(340, "2026-05-08", 22, { bid: 5.40, ask: 5.50, mark: 5.45, delta: 0.48 }),
      call(345, "2026-05-08", 22, { bid: 3.10, ask: 3.20, mark: 3.15, delta: 0.32 }),
      call(350, "2026-05-08", 22, { bid: 1.80, ask: 1.90, mark: 1.85, delta: 0.20 }),
      call(355, "2026-05-08", 22, { bid: 0.95, ask: 1.05, mark: 1.00, delta: 0.12 }),
      call(360, "2026-05-08", 22, { bid: 0.45, ask: 0.55, mark: 0.50, delta: 0.07 }),
    ],
    puts: [],
  };
}

function positionGoogl340C(): PositionForRecommendation {
  return {
    underlying_symbol: "GOOGL",
    option_symbol: "GOOGL 260424C00340000",
    position_type: "SHORT_CALL",
    strike: 340,
    expiry: "2026-04-24",
    quantity: 1,
    current_dte: 8,
    current_mark: 4.35,
  };
}

function defaultThresholds(): PolicyThresholds {
  // Note: rolling a short call UP in strike at the SAME expiry is mechanically a
  // debit (you collect less premium because you're further OTM). The test
  // fixture exposes that real behavior; the algorithm under test is the
  // generator + filter pipeline. min_credit_roll is set permissive here so
  // candidates flow through; a separate strict-filter test exercises the
  // min_credit_roll cutoff itself.
  return {
    min_credit_roll: -500,
    debit_roll_tiers: [10, 40],
    max_dte_days: 5,
    delta_threshold: 0.50,    // 0.50 admits the 340-strike rows in fixtures
  };
}

// A probability engine that always returns 0.30 (so p_profit_30d = 0.70).
function deterministicProbEngine(): ProbabilityEngine {
  return {
    async estimateTargetHit(_db, input): Promise<ProbabilityResult[]> {
      const target = input.target_up ?? input.target_down ?? 0;
      const direction: "up" | "down" = input.target_up != null ? "up" : "down";
      return input.horizons_days.map((h) => ({
        symbol: input.symbol,
        spot: 335.70,
        target,
        direction,
        horizon_days: h,
        probability: 0.30,
        method: "iv_mc",
        paths_simulated: 10000,
        source_iv: 0.28,
        realized_sigma: null,
        computed_at: new Date().toISOString(),
      }));
    },
  };
}

// A probability engine that always throws.
function throwingProbEngine(): ProbabilityEngine {
  return {
    async estimateTargetHit(): Promise<ProbabilityResult[]> {
      throw new Error("simulated engine failure");
    },
  };
}

// Stub D1Database that supports the single SELECT used by readScoringWeights.
// Returns no rows so DEFAULT_SCORING_WEIGHTS is used.
function fakeDb(): D1Database {
  const stub = {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 0 } }),
      }),
    }),
  };
  return stub as unknown as D1Database;
}

// ── findStrikeOffset / findNextExpiry ────────────────────────────────────────

describe("findStrikeOffset", () => {
  it("returns the n-th strike above for calls in the same expiry", () => {
    const chain = chainGooglMay();
    expect(findStrikeOffset(chain, "CALL", "2026-04-24", 340, 1)?.strike).toBe(345);
    expect(findStrikeOffset(chain, "CALL", "2026-04-24", 340, 2)?.strike).toBe(350);
    expect(findStrikeOffset(chain, "CALL", "2026-04-24", 340, 5)?.strike).toBe(365);
  });

  it("returns null when offset exceeds chain depth", () => {
    const chain = chainGooglMay();
    expect(findStrikeOffset(chain, "CALL", "2026-04-24", 340, 10)).toBeNull();
  });

  it("returns null for the wrong expiry", () => {
    const chain = chainGooglMay();
    expect(findStrikeOffset(chain, "CALL", "2099-01-01", 340, 1)).toBeNull();
  });
});

describe("findNextExpiry", () => {
  it("returns the first expiry on or after current_dte + minIncrement", () => {
    const chain = chainGooglMay();
    expect(findNextExpiry(chain, "CALL", 8, 7)).toBe("2026-05-08");
  });

  it("returns null when no chain expiry satisfies the constraint", () => {
    const chain = chainGooglMay();
    expect(findNextExpiry(chain, "CALL", 100, 7)).toBeNull();
  });
});

// ── generateSingleLegRolls ───────────────────────────────────────────────────

describe("generateSingleLegRolls", () => {
  it("produces up to 5 candidates with same expiry as current short", () => {
    const cands = generateSingleLegRolls(positionGoogl340C(), chainGooglMay());
    expect(cands.length).toBe(5);
    for (const c of cands) {
      expect(c.structure).toBe("SINGLE_LEG_ROLL");
      expect(c.legs).toHaveLength(2);
      expect(c.legs[0]!.instruction).toBe("BUY_TO_CLOSE");
      expect(c.legs[1]!.instruction).toBe("SELL_TO_OPEN");
      // Same-expiry roll → same DTE as current.
      expect(c.expected_dte).toBe(8);
    }
  });

  it("returns [] for equity-only positions", () => {
    const pos: PositionForRecommendation = {
      ...positionGoogl340C(),
      position_type: "LONG_STOCK",
    };
    expect(generateSingleLegRolls(pos, chainGooglMay())).toEqual([]);
  });

  it("returns [] when current chain row is missing (no exact match)", () => {
    const pos = positionGoogl340C();
    const chain = chainGooglMay();
    chain.calls = chain.calls.filter((c) => !(c.strike === 340 && c.expiration === "2026-04-24"));
    expect(generateSingleLegRolls(pos, chain)).toEqual([]);
  });
});

// ── generateDiagonalRolls ────────────────────────────────────────────────────

describe("generateDiagonalRolls", () => {
  it("produces up to 3 candidates with a new expiry ≥ current_dte + 7", () => {
    const cands = generateDiagonalRolls(positionGoogl340C(), chainGooglMay());
    expect(cands.length).toBe(3);
    for (const c of cands) {
      expect(c.structure).toBe("DIAGONAL_ROLL");
      expect(c.legs).toHaveLength(2);
      // Different expiry → different DTE from current 8.
      expect(c.expected_dte).toBe(22);
    }
  });

  it("returns [] when no future expiry meets the DTE increment", () => {
    const pos = positionGoogl340C();
    const chain = chainGooglMay();
    chain.calls = chain.calls.filter((c) => c.expiration !== "2026-05-08");
    expect(generateDiagonalRolls(pos, chain)).toEqual([]);
  });
});

// ── applyHardFilters ─────────────────────────────────────────────────────────

describe("applyHardFilters", () => {
  it("rejects candidates whose mid net_credit is below thresholds.min_credit_roll", () => {
    const pos = positionGoogl340C();
    const chain = chainGooglMay();
    const all = [...generateSingleLegRolls(pos, chain), ...generateDiagonalRolls(pos, chain)];
    const strict = { ...defaultThresholds(), min_credit_roll: 100_000 };
    expect(applyHardFilters(all, pos, chain, strict)).toEqual([]);
  });

  it("rejects candidates whose |expected_delta| exceeds delta_threshold", () => {
    const pos = positionGoogl340C();
    const chain = chainGooglMay();
    const all = [...generateSingleLegRolls(pos, chain), ...generateDiagonalRolls(pos, chain)];
    const tightDelta = { ...defaultThresholds(), delta_threshold: 0.05 };
    const passed = applyHardFilters(all, pos, chain, tightDelta);
    for (const c of passed) {
      expect(Math.abs(c.expected_delta)).toBeLessThanOrEqual(0.05);
    }
  });

  it("rejects candidates whose expected_dte exceeds max_dte_days + 30", () => {
    const pos = positionGoogl340C();
    const chain = chainGooglMay();
    const farFuture = { ...defaultThresholds(), max_dte_days: 0 };
    // current expiry has dte=8, diagonal dte=22; with max_dte_days=0 → cap=30. Both still pass.
    // Tighten further to cap=5 by setting max_dte_days = -25 (synthetic): both should fail.
    const tightDte = { ...farFuture, max_dte_days: -25 };
    const cands = [...generateSingleLegRolls(pos, chain), ...generateDiagonalRolls(pos, chain)];
    expect(applyHardFilters(cands, pos, chain, tightDte)).toEqual([]);
  });

  it("rejects candidates whose new short leg has zero bid or ask", () => {
    const pos = positionGoogl340C();
    const chain = chainGooglMay();
    // Set the +1 strike (345) to zero bid.
    const target = chain.calls.find((c) => c.strike === 345 && c.expiration === "2026-04-24")!;
    target.bid = 0;
    const all = [...generateSingleLegRolls(pos, chain), ...generateDiagonalRolls(pos, chain)];
    const passed = applyHardFilters(all, pos, chain, defaultThresholds());
    // The +1 single-leg candidate must be excluded.
    expect(passed.find((c) => c.legs[1]!.symbol === target.symbol)).toBeUndefined();
  });
});

// ── tieBreak ─────────────────────────────────────────────────────────────────

describe("tieBreak", () => {
  function mk(overrides: Partial<RecommendationCandidate>): RecommendationCandidate {
    return {
      structure: "SINGLE_LEG_ROLL",
      legs: [
        { instruction: "BUY_TO_CLOSE", quantity: 1, symbol: "A", asset_type: "OPTION" },
        { instruction: "SELL_TO_OPEN", quantity: 1, symbol: "B", asset_type: "OPTION" },
      ],
      net_credit_range: [100, 100],
      expected_delta: -0.20,
      expected_gamma: -0.04,
      expected_theta: 0.05,
      expected_vega: -0.10,
      expected_dte: 14,
      p_profit_30d: 0.5,
      rationale: "",
      ...overrides,
    };
  }

  it("higher net_credit_range[0] wins", () => {
    const a = mk({ net_credit_range: [120, 130] });
    const b = mk({ net_credit_range: [100, 110] });
    expect(tieBreak(a, b)).toBeLessThan(0);
  });

  it("on equal credit, lower |expected_delta| wins", () => {
    const a = mk({ expected_delta: -0.10 });
    const b = mk({ expected_delta: -0.25 });
    expect(tieBreak(a, b)).toBeLessThan(0);
  });

  it("on equal credit and delta, earlier expected_dte wins", () => {
    const a = mk({ expected_dte: 8 });
    const b = mk({ expected_dte: 22 });
    expect(tieBreak(a, b)).toBeLessThan(0);
  });

  it("on all-else equal, lex on legs[0].symbol", () => {
    const a = mk({ legs: [
      { instruction: "BUY_TO_CLOSE", quantity: 1, symbol: "AAA", asset_type: "OPTION" },
      { instruction: "SELL_TO_OPEN", quantity: 1, symbol: "Z", asset_type: "OPTION" },
    ]});
    const b = mk({ legs: [
      { instruction: "BUY_TO_CLOSE", quantity: 1, symbol: "BBB", asset_type: "OPTION" },
      { instruction: "SELL_TO_OPEN", quantity: 1, symbol: "Z", asset_type: "OPTION" },
    ]});
    expect(tieBreak(a, b)).toBeLessThan(0);
  });
});

// ── recommendCandidates (orchestrator) ───────────────────────────────────────

describe("recommendCandidates", () => {
  it("returns at least one SINGLE_LEG_ROLL and at least one DIAGONAL_ROLL with sufficient chain depth", async () => {
    const bundle = await recommendCandidates({
      db: fakeDb(),
      agentId: "agent-finance-lead",
      position: positionGoogl340C(),
      thresholds: defaultThresholds(),
      chain: chainGooglMay(),
      probabilityEngine: deterministicProbEngine(),
      layer1Decision: "ROLL",
    });
    const structures = new Set(bundle.candidates.map((c) => c.structure));
    expect(structures.has("SINGLE_LEG_ROLL")).toBe(true);
    expect(structures.has("DIAGONAL_ROLL")).toBe(true);
    expect(bundle.candidates.length).toBeGreaterThan(0);
  });

  it("every emitted candidate has exactly 2 legs and satisfies every hard filter", async () => {
    const thresholds = defaultThresholds();
    const bundle = await recommendCandidates({
      db: fakeDb(),
      agentId: "agent-finance-lead",
      position: positionGoogl340C(),
      thresholds,
      chain: chainGooglMay(),
      probabilityEngine: deterministicProbEngine(),
      layer1Decision: "ROLL",
    });
    for (const c of bundle.candidates) {
      expect(c.legs).toHaveLength(2);
      const creditMid = (c.net_credit_range[0] + c.net_credit_range[1]) / 2;
      expect(creditMid).toBeGreaterThanOrEqual(thresholds.min_credit_roll);
      expect(Math.abs(c.expected_delta)).toBeLessThanOrEqual(thresholds.delta_threshold);
      expect(c.expected_dte).toBeLessThanOrEqual(thresholds.max_dte_days + 30);
    }
  });

  it("ranks the top candidate strictly above the runner-up (tie-break enforced)", async () => {
    const bundle = await recommendCandidates({
      db: fakeDb(),
      agentId: "agent-finance-lead",
      position: positionGoogl340C(),
      thresholds: defaultThresholds(),
      chain: chainGooglMay(),
      probabilityEngine: deterministicProbEngine(),
      layer1Decision: "ROLL",
    });
    if (bundle.candidates.length >= 2) {
      const top = bundle.candidates[0]!;
      const runner = bundle.candidates[1]!;
      expect(top.rank).toBe(1);
      expect(runner.rank).toBe(2);
      // Either strictly higher score, or equal score with negative tie-break.
      if (top.score === runner.score) {
        expect(tieBreak(top, runner)).toBeLessThanOrEqual(0);
      } else {
        expect(top.score).toBeGreaterThan(runner.score);
      }
    }
  });

  it("returns an empty candidates array for equity-only positions", async () => {
    const equity: PositionForRecommendation = {
      ...positionGoogl340C(),
      position_type: "LONG_STOCK",
    };
    const bundle = await recommendCandidates({
      db: fakeDb(),
      agentId: "agent-finance-lead",
      position: equity,
      thresholds: defaultThresholds(),
      chain: chainGooglMay(),
      probabilityEngine: deterministicProbEngine(),
      layer1Decision: "CLOSE",
    });
    expect(bundle.candidates).toEqual([]);
    expect(bundle.generation_diagnostics.total_generated).toBe(0);
  });

  it("returns empty candidates when the chain has no usable strikes", async () => {
    const bundle = await recommendCandidates({
      db: fakeDb(),
      agentId: "agent-finance-lead",
      position: positionGoogl340C(),
      thresholds: defaultThresholds(),
      chain: { symbol: "GOOGL", underlying_price: 335.70, as_of: "x", calls: [], puts: [] },
      probabilityEngine: deterministicProbEngine(),
      layer1Decision: "ROLL",
    });
    expect(bundle.candidates).toEqual([]);
  });

  it("when the probability engine throws, p_profit_30d defaults to 0.5 for every affected candidate", async () => {
    const bundle = await recommendCandidates({
      db: fakeDb(),
      agentId: "agent-finance-lead",
      position: positionGoogl340C(),
      thresholds: defaultThresholds(),
      chain: chainGooglMay(),
      probabilityEngine: throwingProbEngine(),
      layer1Decision: "ROLL",
    });
    for (const c of bundle.candidates) {
      expect(c.p_profit_30d).toBe(0.5);
    }
  });

  it("uses DEFAULT_SCORING_WEIGHTS when agent_notes lookup returns no row", async () => {
    expect(DEFAULT_SCORING_WEIGHTS.w_credit).toBe(0.30);
    expect(DEFAULT_SCORING_WEIGHTS.w_pprofit).toBe(0.40);
    expect(DEFAULT_SCORING_WEIGHTS.w_safety).toBe(0.20);
    expect(DEFAULT_SCORING_WEIGHTS.w_dte).toBe(0.10);
    // The stub fakeDb() returns no rows, so the orchestrator must succeed
    // and produce a bundle without error.
    const bundle = await recommendCandidates({
      db: fakeDb(),
      agentId: "agent-finance-lead",
      position: positionGoogl340C(),
      thresholds: defaultThresholds(),
      chain: chainGooglMay(),
      probabilityEngine: deterministicProbEngine(),
      layer1Decision: "ROLL",
    });
    expect(bundle.candidates.length).toBeGreaterThan(0);
  });

  it("diagnostics report strike count and generation/filter counts", async () => {
    const bundle = await recommendCandidates({
      db: fakeDb(),
      agentId: "agent-finance-lead",
      position: positionGoogl340C(),
      thresholds: defaultThresholds(),
      chain: chainGooglMay(),
      probabilityEngine: deterministicProbEngine(),
      layer1Decision: "ROLL",
    });
    expect(bundle.generation_diagnostics.chain_strikes_considered).toBe(11); // total call rows in fixture
    expect(bundle.generation_diagnostics.total_generated).toBeGreaterThanOrEqual(5);
    expect(bundle.generation_diagnostics.after_hard_filters).toBeGreaterThan(0);
    expect(bundle.generation_diagnostics.after_hard_filters).toBeLessThanOrEqual(bundle.generation_diagnostics.total_generated);
  });
});
