/**
 * Candidate Recommender — Phase A.8 (Layer 4 of the Finance-Intelligence
 * layered recommendation engine).
 *
 * Converts a Layer-1 ROLL or CLOSE decision into a ranked list of executable
 * candidate structures. v1 supports two structures only:
 *   - SINGLE_LEG_ROLL: BTC current short + STO new strike, same expiry
 *   - DIAGONAL_ROLL:   BTC current short + STO new strike, new expiry (≥ current_dte + 7)
 *
 * Reads: in-memory inputs (position + thresholds + chain + probability engine).
 * Writes: nothing.
 * Forbidden: DB writes, Schwab API calls, Telegram, order staging, ML beyond
 *            the layered engine.
 *
 * Pure function over its inputs; the probability engine and an optional
 * weights-reader are the only external touch points, and both are injected
 * by the caller (AgentActor in PR-4).
 */

import { queryOne } from "../db/schema";
import type { OptionContract, OptionsChainResult } from "./schwab-positions";
import type { PolicyThresholds } from "./policy-impact-model";
import type { ProbabilityEngine, ProbabilityResult } from "./probability-engine";

// ── Public types ─────────────────────────────────────────────────────────────

export type CandidateStructure = "SINGLE_LEG_ROLL" | "DIAGONAL_ROLL";

export interface OrderLeg {
  instruction: "BUY_TO_OPEN" | "BUY_TO_CLOSE" | "SELL_TO_OPEN" | "SELL_TO_CLOSE";
  quantity: number;
  symbol: string;
  asset_type: "OPTION";
}

export interface RecommendationCandidate {
  structure: CandidateStructure;
  legs: OrderLeg[];
  net_credit_range: [number, number];   // [worst case, best case] in dollars (qty × 100)
  expected_delta: number;
  expected_gamma: number;
  expected_theta: number;
  expected_vega: number;
  expected_dte: number;
  p_profit_30d: number;
  rationale: string;
}

export interface RankedCandidate extends RecommendationCandidate {
  score: number;
  rank: number;                          // 1-indexed
}

export interface RecommendationBundle {
  position_symbol: string;
  layer1_decision: "ROLL" | "CLOSE";
  layer3_probabilities: ProbabilityResult[];
  candidates: RankedCandidate[];
  generation_diagnostics: {
    total_generated: number;
    after_hard_filters: number;
    chain_strikes_considered: number;
  };
}

/**
 * Minimal position shape required by the recommender. AgentActor builds this
 * from a `tws_positions` row joined with its latest `position_snapshots` row.
 */
export interface PositionForRecommendation {
  underlying_symbol: string;
  option_symbol: string;                 // OCC symbol of current short leg
  position_type: string;                 // expected: "SHORT_CALL" | "SHORT_PUT"
  strike: number;
  expiry: string;                        // "YYYY-MM-DD"
  quantity: number;
  current_dte: number;
  current_mark: number;                  // current short leg mark (used for net_credit math)
}

export interface ScoringWeights {
  w_credit: number;
  w_pprofit: number;
  w_safety: number;
  w_dte: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = Object.freeze({
  w_credit: 0.30,
  w_pprofit: 0.40,
  w_safety: 0.20,
  w_dte: 0.10,
});

// ── Internal helpers ─────────────────────────────────────────────────────────

function midpoint(c: OptionContract): number {
  // Defensive: when bid/ask is missing the candidate is filtered out by hard
  // filter #4. midpoint is still computed here for sorting/diagnostics.
  if (c.ask > 0 && c.bid > 0) return (c.bid + c.ask) / 2;
  return c.mark > 0 ? c.mark : 0;
}

function legBuyToClose(symbol: string, qty: number): OrderLeg {
  return { instruction: "BUY_TO_CLOSE", quantity: qty, symbol, asset_type: "OPTION" };
}

function legSellToOpen(symbol: string, qty: number): OrderLeg {
  return { instruction: "SELL_TO_OPEN", quantity: qty, symbol, asset_type: "OPTION" };
}

function isShortCall(positionType: string): boolean {
  return positionType.toUpperCase() === "SHORT_CALL";
}

function isShortPut(positionType: string): boolean {
  return positionType.toUpperCase() === "SHORT_PUT";
}

function chainSide(chain: OptionsChainResult, type: "CALL" | "PUT"): OptionContract[] {
  return type === "CALL" ? chain.calls : chain.puts;
}

/**
 * Enumerate the nth strike above (or below) `fromStrike` on the given chain
 * side, restricted to `expiry`. n is 1-indexed. Returns null if the chain has
 * fewer than n strikes in that direction.
 */
export function findStrikeOffset(
  chain: OptionsChainResult,
  type: "CALL" | "PUT",
  expiry: string,
  fromStrike: number,
  offset: number,           // +1, +2 ... up; -1, -2 ... down
): OptionContract | null {
  if (offset === 0) return null;
  const side = chainSide(chain, type)
    .filter((c) => c.expiration === expiry);
  if (offset > 0) {
    const above = side
      .filter((c) => c.strike > fromStrike)
      .sort((a, b) => a.strike - b.strike);
    return above[offset - 1] ?? null;
  } else {
    const below = side
      .filter((c) => c.strike < fromStrike)
      .sort((a, b) => b.strike - a.strike);
    return below[-offset - 1] ?? null;
  }
}

/**
 * First expiry on the chain (for the given contract type) with
 * `dte >= currentDte + minDteIncrement`. Returns null if none exists.
 */
export function findNextExpiry(
  chain: OptionsChainResult,
  type: "CALL" | "PUT",
  currentDte: number,
  minDteIncrement: number,
): string | null {
  const side = chainSide(chain, type);
  const seen = new Map<string, number>();
  for (const c of side) {
    if (!seen.has(c.expiration)) seen.set(c.expiration, c.dte);
  }
  const sorted = [...seen.entries()].sort((a, b) => a[1] - b[1]);
  for (const [exp, dte] of sorted) {
    if (dte >= currentDte + minDteIncrement) return exp;
  }
  return null;
}

function findChainRowForCurrent(
  chain: OptionsChainResult,
  type: "CALL" | "PUT",
  position: PositionForRecommendation,
): OptionContract | null {
  const side = chainSide(chain, type);
  for (const c of side) {
    if (c.strike === position.strike && c.expiration === position.expiry) return c;
  }
  return null;
}

/**
 * Build a candidate from a (current short row, new short row) pair. Computes
 * net_credit_range, expected post-trade Greeks of the SHORT new leg, expected
 * DTE. p_profit_30d is left as 0 here; the orchestrator fills it in after
 * calling the probability engine.
 *
 * Greeks convention: chain rows give Greeks of the long option. A SHORT
 * position negates them.
 */
function buildCandidate(args: {
  structure: CandidateStructure;
  position: PositionForRecommendation;
  currentRow: OptionContract;
  newRow: OptionContract;
  rationale: string;
}): RecommendationCandidate {
  const { structure, position, currentRow, newRow, rationale } = args;
  const qty = position.quantity;

  // Net credit: (mid(STO) − mid(BTC)) × qty × 100
  const stoMid = midpoint(newRow);
  const btcMid = midpoint(currentRow);
  const creditMid = (stoMid - btcMid) * qty * 100;

  // Range based on bid/ask spread.
  const worst = (newRow.bid - currentRow.ask) * qty * 100;
  const best = (newRow.ask - currentRow.bid) * qty * 100;
  const net_credit_range: [number, number] = [Math.min(worst, creditMid, best), Math.max(worst, creditMid, best)];

  return {
    structure,
    legs: [
      legBuyToClose(position.option_symbol, qty),
      legSellToOpen(newRow.symbol, qty),
    ],
    net_credit_range,
    expected_delta: -1 * newRow.delta,
    expected_gamma: -1 * newRow.gamma,
    expected_theta: -1 * newRow.theta,
    expected_vega: -1 * newRow.vega,
    expected_dte: newRow.dte,
    p_profit_30d: 0,
    rationale,
  };
}

// ── Generators ───────────────────────────────────────────────────────────────

/**
 * SINGLE_LEG_ROLL — same expiry as current, strike shifted ±1..±5.
 * SHORT_CALL: strikes go up (+1..+5). SHORT_PUT: strikes go down (-1..-5).
 */
export function generateSingleLegRolls(
  position: PositionForRecommendation,
  chain: OptionsChainResult,
): RecommendationCandidate[] {
  const isCall = isShortCall(position.position_type);
  const isPut = isShortPut(position.position_type);
  if (!isCall && !isPut) return [];

  const type: "CALL" | "PUT" = isCall ? "CALL" : "PUT";
  const currentRow = findChainRowForCurrent(chain, type, position);
  if (!currentRow) return [];

  const out: RecommendationCandidate[] = [];
  const sign = isCall ? 1 : -1;
  for (let n = 1; n <= 5; n++) {
    const newRow = findStrikeOffset(chain, type, position.expiry, position.strike, sign * n);
    if (!newRow) continue;
    const direction = sign > 0 ? `+${n}` : `-${n}`;
    out.push(buildCandidate({
      structure: "SINGLE_LEG_ROLL",
      position,
      currentRow,
      newRow,
      rationale: `Roll ${direction} strike same expiry (${position.expiry}) — new short ${type} ${newRow.strike}`,
    }));
  }
  return out;
}

/**
 * DIAGONAL_ROLL — different expiry (≥ current_dte + 7 days), strike shifted ±1..±3.
 */
export function generateDiagonalRolls(
  position: PositionForRecommendation,
  chain: OptionsChainResult,
): RecommendationCandidate[] {
  const isCall = isShortCall(position.position_type);
  const isPut = isShortPut(position.position_type);
  if (!isCall && !isPut) return [];

  const type: "CALL" | "PUT" = isCall ? "CALL" : "PUT";
  const currentRow = findChainRowForCurrent(chain, type, position);
  if (!currentRow) return [];

  const newExpiry = findNextExpiry(chain, type, position.current_dte, 7);
  if (!newExpiry) return [];

  const out: RecommendationCandidate[] = [];
  const sign = isCall ? 1 : -1;
  for (let n = 1; n <= 3; n++) {
    const newRow = findStrikeOffset(chain, type, newExpiry, position.strike, sign * n);
    if (!newRow) continue;
    const direction = sign > 0 ? `+${n}` : `-${n}`;
    out.push(buildCandidate({
      structure: "DIAGONAL_ROLL",
      position,
      currentRow,
      newRow,
      rationale: `Diagonal: BTC current ${type} ${position.strike} (${position.expiry}); STO ${direction} strike at next expiry ${newExpiry}`,
    }));
  }
  return out;
}

// ── Hard filters ─────────────────────────────────────────────────────────────

function rowBidAskValid(chain: OptionsChainResult, type: "CALL" | "PUT", strike: number, expiry: string): boolean {
  const c = chainSide(chain, type).find((r) => r.strike === strike && r.expiration === expiry);
  if (!c) return false;
  return c.bid > 0 && c.ask > 0;
}

/**
 * Apply the four hard filters from spec §6 before scoring.
 *   1. net_credit_mid ≥ thresholds.min_credit_roll
 *   2. |expected_delta| ≤ thresholds.delta_threshold
 *   3. expected_dte ≤ thresholds.max_dte_days + 30
 *   4. Both legs' chain rows have bid > 0 AND ask > 0
 */
export function applyHardFilters(
  candidates: RecommendationCandidate[],
  position: PositionForRecommendation,
  chain: OptionsChainResult,
  thresholds: PolicyThresholds,
): RecommendationCandidate[] {
  const type: "CALL" | "PUT" = isShortCall(position.position_type) ? "CALL" : "PUT";
  return candidates.filter((c) => {
    const creditMid = (c.net_credit_range[0] + c.net_credit_range[1]) / 2;
    if (creditMid < thresholds.min_credit_roll) return false;
    if (Math.abs(c.expected_delta) > thresholds.delta_threshold) return false;
    if (c.expected_dte > thresholds.max_dte_days + 30) return false;
    // Both legs must have valid bid/ask. The current row exists by construction
    // of the candidate; we still check it explicitly.
    if (!rowBidAskValid(chain, type, position.strike, position.expiry)) return false;
    const newStrike = c.legs[1]?.symbol;
    if (!newStrike) return false;
    const newRow = chainSide(chain, type).find((r) => r.symbol === newStrike);
    if (!newRow) return false;
    if (!(newRow.bid > 0 && newRow.ask > 0)) return false;
    return true;
  });
}

// ── Scoring + tie-break ──────────────────────────────────────────────────────

function midOfRange(range: [number, number]): number {
  return (range[0] + range[1]) / 2;
}

function computeScore(
  c: RecommendationCandidate,
  maxCredit: number,
  thresholds: PolicyThresholds,
  weights: ScoringWeights,
): number {
  const credit = midOfRange(c.net_credit_range);
  const creditTerm = maxCredit > 0 ? credit / maxCredit : 0;
  const pprofitTerm = c.p_profit_30d;
  const safetyTerm = thresholds.delta_threshold > 0
    ? Math.max(0, 1 - Math.abs(c.expected_delta) / thresholds.delta_threshold)
    : 0;
  const targetDte = thresholds.max_dte_days + 14;
  const dteTerm = targetDte > 0
    ? Math.max(0, 1 - Math.abs(c.expected_dte - targetDte) / targetDte)
    : 0;
  return (
    weights.w_credit * creditTerm +
    weights.w_pprofit * pprofitTerm +
    weights.w_safety * safetyTerm +
    weights.w_dte * dteTerm
  );
}

/**
 * Deterministic tie-break. Returns negative if a should rank above b, positive
 * if b should rank above a, 0 only when truly identical on every dimension.
 */
export function tieBreak(a: RecommendationCandidate, b: RecommendationCandidate): number {
  // 1. Higher net_credit_range[0] (worst-case credit) wins.
  if (b.net_credit_range[0] !== a.net_credit_range[0]) return b.net_credit_range[0] - a.net_credit_range[0];
  // 2. Lower |expected_delta| wins.
  const ad = Math.abs(a.expected_delta);
  const bd = Math.abs(b.expected_delta);
  if (ad !== bd) return ad - bd;
  // 3. Earlier expected_dte wins.
  if (a.expected_dte !== b.expected_dte) return a.expected_dte - b.expected_dte;
  // 4. Lexicographic on legs[0].symbol.
  const aSym = a.legs[0]?.symbol ?? "";
  const bSym = b.legs[0]?.symbol ?? "";
  return aSym < bSym ? -1 : aSym > bSym ? 1 : 0;
}

// ── Scoring weights reader ───────────────────────────────────────────────────

export async function readScoringWeights(db: D1Database, agentId: string): Promise<ScoringWeights> {
  try {
    const row = await queryOne<{ value: string }>(
      db,
      "SELECT value FROM agent_notes WHERE agent_id = ? AND key = 'candidate_scoring_weights_json' LIMIT 1",
      [agentId],
    );
    if (!row?.value) return DEFAULT_SCORING_WEIGHTS;
    const parsed = JSON.parse(row.value) as Partial<ScoringWeights>;
    return {
      w_credit: typeof parsed.w_credit === "number" ? parsed.w_credit : DEFAULT_SCORING_WEIGHTS.w_credit,
      w_pprofit: typeof parsed.w_pprofit === "number" ? parsed.w_pprofit : DEFAULT_SCORING_WEIGHTS.w_pprofit,
      w_safety: typeof parsed.w_safety === "number" ? parsed.w_safety : DEFAULT_SCORING_WEIGHTS.w_safety,
      w_dte: typeof parsed.w_dte === "number" ? parsed.w_dte : DEFAULT_SCORING_WEIGHTS.w_dte,
    };
  } catch {
    return DEFAULT_SCORING_WEIGHTS;
  }
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Generate + filter + score + rank candidate structures for a single position.
 * Returns the full bundle including diagnostics. Empty candidates list is
 * a valid result (caller renders "no qualifying candidate").
 *
 * For each generated candidate, calls `probabilityEngine.estimateTargetHit`
 * with the new short leg's strike as the target. On engine error, the
 * candidate is scored with p_profit_30d = 0.5 (neutral prior) and continues.
 */
export async function recommendCandidates(args: {
  db: D1Database;
  agentId: string;
  position: PositionForRecommendation;
  thresholds: PolicyThresholds;
  chain: OptionsChainResult;
  probabilityEngine: ProbabilityEngine;
  layer1Decision: "ROLL" | "CLOSE";
  layer3Probabilities?: ProbabilityResult[];     // optional: caller may have already computed these
  weightsOverride?: ScoringWeights;              // test injection
}): Promise<RecommendationBundle> {
  const { db, agentId, position, thresholds, chain, probabilityEngine, layer1Decision } = args;

  // Equity-only invariant: candidates only attach to SHORT_CALL / SHORT_PUT.
  if (!isShortCall(position.position_type) && !isShortPut(position.position_type)) {
    return {
      position_symbol: position.underlying_symbol,
      layer1_decision: layer1Decision,
      layer3_probabilities: args.layer3Probabilities ?? [],
      candidates: [],
      generation_diagnostics: { total_generated: 0, after_hard_filters: 0, chain_strikes_considered: 0 },
    };
  }

  const type: "CALL" | "PUT" = isShortCall(position.position_type) ? "CALL" : "PUT";
  const chainStrikesConsidered = chainSide(chain, type).length;

  const single = generateSingleLegRolls(position, chain);
  const diagonal = generateDiagonalRolls(position, chain);
  const generated = [...single, ...diagonal];

  const filtered = applyHardFilters(generated, position, chain, thresholds);

  // Compute p_profit_30d for each filtered candidate.
  const isCall = type === "CALL";
  for (const c of filtered) {
    // New short leg symbol → look up its strike on the chain.
    const stoLeg = c.legs[1];
    const newRow = stoLeg
      ? chainSide(chain, type).find((r) => r.symbol === stoLeg.symbol)
      : null;
    const newStrike = newRow?.strike;
    if (newStrike == null) {
      c.p_profit_30d = 0.5;
      continue;
    }
    try {
      const results = await probabilityEngine.estimateTargetHit(db, {
        symbol: position.underlying_symbol,
        target_up: isCall ? newStrike : undefined,
        target_down: !isCall ? newStrike : undefined,
        horizons_days: [30],
      });
      const found = results.find((r) => r.horizon_days === 30);
      // P(profit) = 1 − P(touch new short strike against us).
      c.p_profit_30d = found ? Math.max(0, Math.min(1, 1 - found.probability)) : 0.5;
    } catch {
      c.p_profit_30d = 0.5;
    }
  }

  const weights = args.weightsOverride ?? (await readScoringWeights(db, agentId));
  const maxCredit = Math.max(0, ...filtered.map((c) => midOfRange(c.net_credit_range)));

  const scored = filtered.map((c) => ({
    ...c,
    score: computeScore(c, maxCredit, thresholds, weights),
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return tieBreak(a, b);
  });

  const ranked: RankedCandidate[] = scored.map((c, i) => ({ ...c, rank: i + 1 }));

  return {
    position_symbol: position.underlying_symbol,
    layer1_decision: layer1Decision,
    layer3_probabilities: args.layer3Probabilities ?? [],
    candidates: ranked,
    generation_diagnostics: {
      total_generated: generated.length,
      after_hard_filters: filtered.length,
      chain_strikes_considered: chainStrikesConsidered,
    },
  };
}
