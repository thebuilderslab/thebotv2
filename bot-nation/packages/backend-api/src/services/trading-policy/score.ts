// R-WEEKLY-DIRECTOR.1 — candidate scoring.
//
// Verbatim from the spec author's `TRADING Candidate scoring.txt`. Higher
// score = better candidate. Used by `evaluatePosition` to rank eligible
// candidates within each kind (NEXT_WEEK first, SAME_WEEK fallback).
//
// Determinism: scoreCandidate is a pure function of (candidate, market).
// `compareCandidateScoreDesc` is stable across runs because the inputs
// come from a deterministic pipeline.

import type { CandidateEvaluation, MarketContextSnapshot, RollCandidate } from "./types";

export function scoreCandidate(candidate: RollCandidate, market: MarketContextSnapshot): number {
  let score = 0;
  score += candidate.estimatedProfitImprovementPct * 100;
  score += (candidate.deltaReductionPctFromCurrent ?? 0) * 30;
  score -= candidate.spread * 10;

  if (market.trendRegime === "BULL_EXT" || market.trendRegime === "BEAR_EXT") {
    score += (candidate.deltaReductionPctFromCurrent ?? 0) * 20;
  }

  return score;
}

/**
 * Sort comparator for `Array.sort()`: highest score first. Eligible-only
 * candidates carry a `score` field; ineligible candidates are filtered
 * out before sorting (enforced by `evaluatePosition`).
 */
export function compareCandidateScoreDesc(
  a: CandidateEvaluation,
  b: CandidateEvaluation,
): number {
  const sa = a.score ?? -Infinity;
  const sb = b.score ?? -Infinity;
  return sb - sa;
}
