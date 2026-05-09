// R-WEEKLY-DIRECTOR.1 — deterministic evaluator.
//
// Verbatim translation of the spec author's `TRADING Pseudocode.txt` into
// TypeScript with proper imports and types. Two top-level functions:
//   - evaluatePosition  — single-position decision
//   - evaluateAccount   — aggregate per-position decisions for a cycle
// Plus the per-candidate filter `evaluateCandidate`.
//
// PURE FUNCTIONS. No DB writes, no Schwab calls, no side effects. Inputs
// are policy + plain snapshots; outputs are decision objects. The
// orchestrator in `services/trading/weekly-options-director.ts` is
// responsible for fetching data and emitting events around these calls.

import type {
  AccountSnapshot,
  CandidateEvaluation,
  DecisionReasonCode,
  MarketContextSnapshot,
  PositionDecision,
  PositionSnapshot,
  RollCandidate,
  TradingPolicy,
  WeeklyAccountDecision,
} from "./types";
import { compareCandidateScoreDesc, scoreCandidate } from "./score";
import {
  buildNoRollReasons,
  increasesRisk,
  pickMarketContext,
  reducesRisk,
  regimeAllowsCandidate,
} from "./helpers";

// ── Single-candidate filter ──────────────────────────────────────────────────

export function evaluateCandidate(
  policy: TradingPolicy,
  position: PositionSnapshot,
  market: MarketContextSnapshot,
  candidate: RollCandidate,
  kind: "NEXT_WEEK" | "SAME_WEEK",
  eventRestricted: boolean,
): CandidateEvaluation {
  const reasons: DecisionReasonCode[] = [];

  if (candidate.isNetDebit && !policy.risk.allowNetDebitRolls) {
    reasons.push("NET_DEBIT_REJECTED");
  }

  if (!candidate.isLiquidityAcceptable) {
    reasons.push("LIQUIDITY_FAILED");
  }

  if (policy.risk.requireSimilarMarginFootprint && !candidate.preservesSimilarMarginFootprint) {
    reasons.push("MARK_RANGE_FAILED");
  }

  if (policy.risk.preserveMarkRange && !candidate.preservesMarkRange) {
    reasons.push("MARK_RANGE_FAILED");
  }

  if (kind === "NEXT_WEEK") {
    if (candidate.estimatedProfitImprovementPct < policy.profits.nextWeekProfitImprovementMinPct) {
      reasons.push("PROFIT_RULE_FAILED");
    }
    const targetReduction = policy.deltas.nextWeekTargetDeltaReductionPct;
    if (
      candidate.deltaReductionPctFromCurrent == null ||
      candidate.deltaReductionPctFromCurrent < targetReduction
    ) {
      reasons.push("DELTA_RULE_FAILED");
    }
  }

  if (kind === "SAME_WEEK") {
    if (candidate.estimatedProfitImprovementPct < policy.profits.sameWeekProfitImprovementMinPct) {
      reasons.push("PROFIT_RULE_FAILED");
    }
    if (
      candidate.deltaAbsChange == null ||
      Math.abs(candidate.deltaAbsChange) > policy.deltas.sameWeekMaxAbsDeltaChange
    ) {
      reasons.push("DELTA_RULE_FAILED");
    }
  }

  if (eventRestricted && increasesRisk(candidate, position)) {
    reasons.push("EVENT_FILTER");
  }

  if (market.volatilityRegime === "VOL_HIGH" || market.volatilityRegime === "VOL_HIGH_INTRADAY") {
    if (!reducesRisk(candidate, position, market)) {
      reasons.push("VOLATILITY_FILTER");
    }
  }

  if (!regimeAllowsCandidate(market.trendRegime, position, candidate)) {
    reasons.push("DELTA_RULE_FAILED");
  }

  return {
    candidate,
    eligible: reasons.length === 0,
    rejectionReasons: reasons,
    score: reasons.length === 0 ? scoreCandidate(candidate, market) : undefined,
  };
}

// ── Per-position decision ────────────────────────────────────────────────────

export function evaluatePosition(
  policy: TradingPolicy,
  position: PositionSnapshot,
  market: MarketContextSnapshot,
  nextWeekCandidates: RollCandidate[],
  sameWeekCandidates: RollCandidate[],
): PositionDecision {
  const rejected: CandidateEvaluation[] = [];

  // 1) Hard stop-loss override
  if (position.pnlPct <= policy.risk.stopLossPnlPct) {
    return {
      accountId:    position.accountId,
      positionId:   position.positionId,
      symbol:       position.symbol,
      selectedAction: "CLOSE",
      primaryReason:  "POSITION_STOP_LOSS",
      reasons:        ["POSITION_STOP_LOSS"],
      marketContext:  pickMarketContext(market),
      rejectedCandidates: rejected,
    };
  }

  // 2) Event / volatility flags can restrict new risk.
  const eventRestricted =
    market.hasEarningsTodayOrTomorrow || market.hasMajorMacroEvent;

  const regimeRule = policy.regimeRules.find((r) => r.regime === market.trendRegime);
  if (!regimeRule) {
    // Defensive: if a regime is missing from the policy table, default to HOLD.
    return {
      accountId:    position.accountId,
      positionId:   position.positionId,
      symbol:       position.symbol,
      selectedAction: "HOLD",
      primaryReason:  "PRECHECK_FAILED",
      reasons:        ["PRECHECK_FAILED"],
      marketContext:  pickMarketContext(market),
      rejectedCandidates: rejected,
    };
  }

  // 3) Evaluate next-week first
  const eligibleNext = nextWeekCandidates
    .map((c) => evaluateCandidate(policy, position, market, c, "NEXT_WEEK", eventRestricted))
    .filter((e) => {
      rejected.push(e);
      return e.eligible;
    })
    .sort(compareCandidateScoreDesc);

  if (regimeRule.allowRollNextWeek && eligibleNext.length > 0) {
    return {
      accountId:    position.accountId,
      positionId:   position.positionId,
      symbol:       position.symbol,
      selectedAction: "ROLL_NEXT_WEEK",
      primaryReason:  "NEXT_WEEK_ROLL_SELECTED",
      reasons:        ["NEXT_WEEK_ROLL_SELECTED"],
      marketContext:  pickMarketContext(market),
      chosenCandidate: eligibleNext[0]!.candidate,
      rejectedCandidates: rejected,
    };
  }

  // 4) Fallback to same-week
  const eligibleSame = sameWeekCandidates
    .map((c) => evaluateCandidate(policy, position, market, c, "SAME_WEEK", eventRestricted))
    .filter((e) => {
      rejected.push(e);
      return e.eligible;
    })
    .sort(compareCandidateScoreDesc);

  if (regimeRule.allowRollSameWeek && eligibleSame.length > 0) {
    return {
      accountId:    position.accountId,
      positionId:   position.positionId,
      symbol:       position.symbol,
      selectedAction: "ROLL_SAME_WEEK",
      primaryReason:  "SAME_WEEK_ROLL_SELECTED",
      reasons:        ["SAME_WEEK_ROLL_SELECTED"],
      marketContext:  pickMarketContext(market),
      chosenCandidate: eligibleSame[0]!.candidate,
      rejectedCandidates: rejected,
    };
  }

  // 5) No valid roll: default by regime is HOLD in current policy
  return {
    accountId:    position.accountId,
    positionId:   position.positionId,
    symbol:       position.symbol,
    selectedAction: regimeRule.defaultActionWhenNoValidRoll,
    primaryReason:  "REGIME_HOLD",
    reasons:        buildNoRollReasons(rejected),
    marketContext:  pickMarketContext(market),
    rejectedCandidates: rejected,
  };
}

// ── Per-account aggregator ───────────────────────────────────────────────────

export function evaluateAccount(
  policy: TradingPolicy,
  account: AccountSnapshot,
  positions: PositionSnapshot[],
  marketByUnderlying: Record<string, MarketContextSnapshot>,
  candidatesByPosition: Record<string, { nextWeek: RollCandidate[]; sameWeek: RollCandidate[] }>,
  weeklyCycleId: string,
  startedAtIso: string,
): WeeklyAccountDecision {
  const decisions: PositionDecision[] = [];

  for (const position of positions) {
    const market = marketByUnderlying[position.symbol];
    if (!market) {
      // No market data for this underlying — emit a PRECHECK_FAILED HOLD
      // so the cycle still produces a complete record.
      decisions.push({
        accountId:    position.accountId,
        positionId:   position.positionId,
        symbol:       position.symbol,
        selectedAction: "HOLD",
        primaryReason:  "PRECHECK_FAILED",
        reasons:        ["PRECHECK_FAILED"],
        marketContext:  {
          trendRegime:      "CHOP",
          volatilityRegime: "VOL_NORMAL",
          targetHigh:       0,
          targetLow:        0,
        },
        rejectedCandidates: [],
      });
      continue;
    }

    const candidates = candidatesByPosition[position.positionId] ?? { nextWeek: [], sameWeek: [] };
    decisions.push(
      evaluatePosition(policy, position, market, candidates.nextWeek, candidates.sameWeek),
    );
  }

  return {
    weeklyCycleId,
    accountId: account.accountId,
    decisions,
    startedAtIso,
  };
}
