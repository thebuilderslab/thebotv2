// R-WEEKLY-DIRECTOR.1 — initial in-code policy constant.
//
// Verbatim from the spec author's `TRADING Suggested initial in-code policy
// constant for R-DIR.txt`. (The source filename references the old "R-DIR"
// label; the policy itself is the weekly options director's policy and
// is unchanged from the spec.)
//
// No D1 storage in .1 per the approved plan. When/if versioning,
// per-account overrides, or operator-editable policy is needed, this
// constant will be the canonical fallback.

import type { TradingPolicy } from "./types";

export const WEEKLY_OPTIONS_POLICY_V1: TradingPolicy = {
  version: "weekly-options-v1",
  schedule: {
    weekday: "WED",
    windowStartEt: "09:30",
    windowEndEt: "11:00",
    cancelCutoffEt: "10:55",
  },
  universe: {
    fallbackSymbol: "SPY",
    manageExistingPositionsOnly: true,
    allowAllExistingOptionPositionTypes: true,
  },
  profits: {
    nextWeekProfitImprovementMinPct: 0.40,
    sameWeekProfitImprovementMinPct: 0.10,
  },
  deltas: {
    sameWeekMaxAbsDeltaChange: 0.03,
    nextWeekTargetDeltaReductionPct: 0.40,
  },
  risk: {
    stopLossPnlPct: -0.40,
    allowNetDebitRolls: false,
    preserveMarkRange: true,
    maxRelativeMarkIncreasePct: 0.10,
    requireSimilarMarginFootprint: true,
  },
  volatility: {
    atrBandMultiplier: 1.0,
    unusualVolatilityAtrRatio: 1.5,
  },
  execution: {
    orderType: "LIMIT_ONLY",
    startPriceMode: "MID",
    repricingMode: "MODERATE",
    maxAttempts: 4,
    maxTicksTowardNatural: 3,
    maxSpreadCrossPct: 0.5,
    singleOrderOnly: true,
  },
  reporting: {
    telegramDetailLevel: "FULL_DEBUG",
    emitEvents: true,
  },
  regimeRules: [
    {
      regime: "BULL_STRONG",
      allowRollNextWeek: true,
      allowRollSameWeek: true,
      defaultActionWhenNoValidRoll: "HOLD",
      notes: "Roll only if already profitable or near target; otherwise hold.",
    },
    {
      regime: "BULL_PULLBACK",
      allowRollNextWeek: true,
      allowRollSameWeek: true,
      defaultActionWhenNoValidRoll: "HOLD",
      notes: "Roll only if bullish thesis preserved.",
    },
    {
      regime: "BULL_EXT",
      allowRollNextWeek: true,
      allowRollSameWeek: true,
      defaultActionWhenNoValidRoll: "HOLD",
      notes: "Roll only if profit target met and risk reduced.",
    },
    {
      regime: "BEAR_STRONG",
      allowRollNextWeek: true,
      allowRollSameWeek: true,
      defaultActionWhenNoValidRoll: "HOLD",
      notes: "Mirror bullish logic in bearish direction.",
    },
    {
      regime: "BEAR_PULLBACK",
      allowRollNextWeek: true,
      allowRollSameWeek: true,
      defaultActionWhenNoValidRoll: "HOLD",
      notes: "Roll only if bearish thesis preserved.",
    },
    {
      regime: "BEAR_EXT",
      allowRollNextWeek: true,
      allowRollSameWeek: true,
      defaultActionWhenNoValidRoll: "HOLD",
      notes: "Roll only if profit target met and risk reduced.",
    },
    {
      regime: "CHOP",
      allowRollNextWeek: true,
      allowRollSameWeek: true,
      defaultActionWhenNoValidRoll: "HOLD",
      notes: "Mostly hold; only roll if risk improves clearly.",
    },
  ],
};
