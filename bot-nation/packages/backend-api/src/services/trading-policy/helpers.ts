// R-WEEKLY-DIRECTOR.1 — small helpers used by `evaluate.ts`.
//
// These are referenced by name in the spec's pseudocode (`pickMarketContext`,
// `regimeAllowsCandidate`, `reducesRisk`, `increasesRisk`, `buildNoRollReasons`)
// but the bodies were not given. Implementations below are conservative
// defaults that match the policy's intent (strict, dry-run-safe). They
// are pure functions; behavior must remain deterministic so the fixtures
// stay stable.

import type {
  CandidateEvaluation,
  DecisionReasonCode,
  MarketContextSnapshot,
  PositionDecision,
  PositionSnapshot,
  RollCandidate,
} from "./types";

/**
 * Project the full MarketContextSnapshot down to the audit-friendly subset
 * embedded in PositionDecision.marketContext. The full snapshot is a lot
 * to log per-decision; this picks just regime + targets which are the
 * fields operators look at when reviewing decisions.
 */
export function pickMarketContext(
  market: MarketContextSnapshot,
): PositionDecision["marketContext"] {
  return {
    trendRegime:      market.trendRegime,
    volatilityRegime: market.volatilityRegime,
    targetHigh:       market.targetHigh,
    targetLow:        market.targetLow,
  };
}

/**
 * "Risk" for an option position is signed delta × quantity. A roll
 * "reduces risk" if the absolute delta of the new position is smaller
 * than the absolute delta of the current position. Used by the volatility
 * filter — under VOL_HIGH regimes we only allow candidates that REDUCE
 * directional exposure.
 *
 * The market arg is reserved for future per-regime risk shaping; .1
 * computes risk position-locally only.
 */
export function reducesRisk(
  candidate: RollCandidate,
  position: PositionSnapshot,
  _market: MarketContextSnapshot,
): boolean {
  if (position.delta == null || candidate.newDelta == null) return false;
  return Math.abs(candidate.newDelta) < Math.abs(position.delta);
}

/**
 * Inverse of reducesRisk — used by the EVENT_FILTER (don't increase risk
 * on a roll if earnings or a macro event lands in the window).
 */
export function increasesRisk(candidate: RollCandidate, position: PositionSnapshot): boolean {
  if (position.delta == null || candidate.newDelta == null) return false;
  return Math.abs(candidate.newDelta) > Math.abs(position.delta);
}

/**
 * Per-regime allow-list for candidate directionality. Defaults to TRUE
 * (regime allows the candidate); the `regimeRules[].allowRollNextWeek`
 * / `allowRollSameWeek` policy already gates the broader decision tree
 * upstream. This helper is a position-level fine-grain check — currently
 * only used to reject "wrong-side" candidates (e.g. a CALL roll into a
 * higher strike when the regime is bearish-extended).
 *
 * .1 implementation: conservative — never reject in here. The richer
 * regime-vs-candidate matrix is deferred to .2 when live execution
 * makes mis-categorization costly.
 */
export function regimeAllowsCandidate(
  trendRegime: MarketContextSnapshot["trendRegime"],
  position: PositionSnapshot,
  candidate: RollCandidate,
): boolean {
  // Reserved for future fine-grained matrix. .1: permissive.
  void trendRegime;
  void position;
  void candidate;
  return true;
}

/**
 * Aggregate the reasons across all rejected candidates into a deduped,
 * priority-ordered list of `DecisionReasonCode`s. Used as the `reasons[]`
 * payload on a HOLD decision when no candidate qualified — the operator
 * sees "why no roll happened" without scrolling through every rejected
 * candidate's reason list.
 *
 * Always includes either NO_VALID_NEXT_WEEK_ROLL or NO_VALID_SAME_WEEK_ROLL
 * (or both) as the leading code so HOLDs with empty rejected[] still
 * carry a structural marker.
 */
export function buildNoRollReasons(rejected: CandidateEvaluation[]): DecisionReasonCode[] {
  const reasons: DecisionReasonCode[] = [];
  const sawNextWeek = rejected.some((e) => e.candidate.candidateType === "NEXT_WEEK");
  const sawSameWeek = rejected.some((e) => e.candidate.candidateType === "SAME_WEEK");
  if (sawNextWeek) reasons.push("NO_VALID_NEXT_WEEK_ROLL");
  if (sawSameWeek) reasons.push("NO_VALID_SAME_WEEK_ROLL");
  // If no candidates were generated at all, both flags are false; surface
  // a single marker so the decision still has structure.
  if (!sawNextWeek && !sawSameWeek) reasons.push("NO_VALID_NEXT_WEEK_ROLL");

  // Aggregate underlying rejection reason codes (deduped, in first-seen
  // order across all rejected evaluations).
  const seen = new Set<DecisionReasonCode>(reasons);
  for (const ev of rejected) {
    for (const code of ev.rejectionReasons) {
      if (!seen.has(code)) {
        seen.add(code);
        reasons.push(code);
      }
    }
  }
  return reasons;
}
