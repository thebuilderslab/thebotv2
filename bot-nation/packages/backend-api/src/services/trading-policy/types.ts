// R-WEEKLY-DIRECTOR.1 — Phase B trading policy enforcement types.
//
// Verbatim from the spec author's `TRADING packagesbackend-apisrcservicestrad.txt`
// (with one minor adjustment: `PositionSnapshot.positionId` is `string`, matching
// the rest of the file). No changes to semantics, only to keep the types
// self-consistent within this codebase.
//
// IMPORTANT: NOT a public ABI. The pure-function modules in this directory
// (`classify`, `candidates`, `score`, `evaluate`) consume these types
// internally. Do NOT rename without updating the orchestrator in
// `services/trading/`.

export type TrendRegime =
  | "BULL_STRONG"
  | "BULL_PULLBACK"
  | "BULL_EXT"
  | "BEAR_STRONG"
  | "BEAR_PULLBACK"
  | "BEAR_EXT"
  | "CHOP";

export type VolatilityRegime =
  | "VOL_LOW"
  | "VOL_NORMAL"
  | "VOL_HIGH"
  | "VOL_HIGH_INTRADAY";

export type PositionAction =
  | "ROLL_NEXT_WEEK"
  | "ROLL_SAME_WEEK"
  | "HOLD"
  | "CLOSE";

export type DecisionReasonCode =
  | "PRECHECK_FAILED"
  | "POSITION_STOP_LOSS"
  | "NO_VALID_NEXT_WEEK_ROLL"
  | "NO_VALID_SAME_WEEK_ROLL"
  | "NEXT_WEEK_ROLL_SELECTED"
  | "SAME_WEEK_ROLL_SELECTED"
  | "REGIME_HOLD"
  | "VOLATILITY_FILTER"
  | "EVENT_FILTER"
  | "NET_DEBIT_REJECTED"
  | "DELTA_RULE_FAILED"
  | "PROFIT_RULE_FAILED"
  | "MARK_RANGE_FAILED"
  | "LIQUIDITY_FAILED"
  | "ORDER_NOT_FILLED_BY_CUTOFF";

export interface WeeklySchedulePolicy {
  weekday: "WED";
  windowStartEt: string;   // "09:30"
  windowEndEt: string;     // "11:00"
  cancelCutoffEt: string;  // "10:55"
}

export interface ProfitRules {
  nextWeekProfitImprovementMinPct: number; // 0.40
  sameWeekProfitImprovementMinPct: number; // 0.10
}

export interface DeltaRules {
  sameWeekMaxAbsDeltaChange: number;       // 0.03
  nextWeekTargetDeltaReductionPct: number; // 0.40
}

export interface RiskRules {
  stopLossPnlPct: number;                  // -0.40
  allowNetDebitRolls: false;
  preserveMarkRange: boolean;
  maxRelativeMarkIncreasePct: number;      // optional guard, e.g. 0.10
  requireSimilarMarginFootprint: boolean;
}

export interface VolatilityRules {
  atrBandMultiplier: number;               // 1.0
  unusualVolatilityAtrRatio: number;       // 1.5
}

export interface ExecutionRules {
  orderType: "LIMIT_ONLY";
  startPriceMode: "MID";
  repricingMode: "MODERATE";
  maxAttempts: number;                     // 4
  maxTicksTowardNatural: number;           // 2 or 3
  maxSpreadCrossPct: number;               // 0.5
  singleOrderOnly: true;
}

export interface UniverseRules {
  fallbackSymbol: "SPY";
  manageExistingPositionsOnly: true;
  allowAllExistingOptionPositionTypes: true;
}

export interface ReportingRules {
  telegramDetailLevel: "FULL_DEBUG";
  emitEvents: true;
}

export interface RegimeActionRule {
  regime: TrendRegime;
  allowRollNextWeek: boolean;
  allowRollSameWeek: boolean;
  defaultActionWhenNoValidRoll: "HOLD" | "CLOSE";
  notes: string;
}

export interface TradingPolicy {
  version: string;
  schedule: WeeklySchedulePolicy;
  universe: UniverseRules;
  profits: ProfitRules;
  deltas: DeltaRules;
  risk: RiskRules;
  volatility: VolatilityRules;
  execution: ExecutionRules;
  reporting: ReportingRules;
  regimeRules: RegimeActionRule[];
}

export interface AccountSnapshot {
  accountId: string;
  buyingPower?: number | null;
  timestampIso: string;
}

export interface PositionSnapshot {
  accountId: string;
  symbol: string;
  positionId: string;
  optionType: "CALL" | "PUT";
  side: "LONG" | "SHORT";
  quantity: number;
  strike: number;
  expirationDate: string;     // YYYY-MM-DD
  mark: number;
  delta: number | null;
  pnlPct: number;             // -0.4386 => -43.86%
  daysToExpiry: number;
  underlyingPrice: number;
  strategyTag?: string | null;
}

export interface MarketContextSnapshot {
  symbol: string;
  asOfIso: string;
  trendRegime: TrendRegime;
  volatilityRegime: VolatilityRegime;
  todayOpen: number;
  atr14: number;
  atr20Avg: number;
  targetHigh: number;
  targetLow: number;
  priorHigh: number;
  priorLow: number;
  priorClose: number;
  hasEarningsTodayOrTomorrow: boolean;
  hasMajorMacroEvent: boolean;
  priceVsEma21h?: "ABOVE" | "BELOW" | "MIXED";
}

export interface RollCandidate {
  symbol: string;
  fromPositionId: string;
  candidateType: "NEXT_WEEK" | "SAME_WEEK";
  newExpirationDate: string;
  newStrike: number;
  newMark: number;
  estimatedNetCredit: number;
  estimatedProfitImprovementPct: number;     // 0.40 => +40%
  newDelta: number | null;
  deltaAbsChange: number | null;
  deltaReductionPctFromCurrent: number | null;
  bid: number;
  ask: number;
  spread: number;
  isNetDebit: boolean;
  isLiquidityAcceptable: boolean;
  preservesSimilarMarginFootprint: boolean;
  preservesMarkRange: boolean;
}

export interface CandidateEvaluation {
  candidate: RollCandidate;
  eligible: boolean;
  rejectionReasons: DecisionReasonCode[];
  score?: number;
}

export interface PositionDecision {
  accountId: string;
  positionId: string;
  symbol: string;
  selectedAction: PositionAction;
  primaryReason: DecisionReasonCode;
  reasons: DecisionReasonCode[];
  marketContext: Pick<MarketContextSnapshot, "trendRegime" | "volatilityRegime" | "targetHigh" | "targetLow">;
  chosenCandidate?: RollCandidate;
  rejectedCandidates: CandidateEvaluation[];
}

export interface WeeklyAccountDecision {
  weeklyCycleId: string;
  accountId: string;
  decisions: PositionDecision[];
  startedAtIso: string;
  completedAtIso?: string;
}
