// R-WEEKLY-DIRECTOR.1 — candidate generation.
//
// PURE FUNCTIONS. Inputs are policy + plain raw chain rows + a position;
// outputs are RollCandidate[] partitioned by NEXT_WEEK / SAME_WEEK. The
// orchestrator in `services/trading/weekly-options-director.ts` is
// responsible for fetching the option chain (via schwab-positions
// `fetchOptionsChain`) and shaping rows into `RawChainRow` before
// calling these functions.
//
// .1 generates a conservative candidate set: per expiry/contract-type
// matching the position, the K nearest strikes around the underlying.
// Each candidate is annotated with the derived metrics that
// `evaluateCandidate` then uses (estimated profit improvement, delta
// reduction, liquidity, mark/margin preservation, net-debit flag).

import type {
  PositionSnapshot,
  RollCandidate,
  TradingPolicy,
} from "./types";

// Plain chain row consumed by the candidate builders. Mirrors the public
// fields of `OptionContract` from `schwab-positions.ts` but lives here so
// `trading-policy/` stays Schwab-import-free.
export interface RawChainRow {
  symbol: string;        // OCC symbol of the candidate contract
  strike: number;
  expirationDate: string; // YYYY-MM-DD
  bid: number;
  ask: number;
  mark: number;
  delta: number | null;
  volume: number;
  openInterest: number;
  contractType: "CALL" | "PUT";
  dte: number;
}

export interface CandidateBuildInput {
  position: PositionSnapshot;
  // Chain rows the orchestrator already filtered to the position's
  // contract-type and to the relevant expiration window (this Friday
  // for SAME_WEEK, next Friday for NEXT_WEEK).
  chainRowsThisWeek: RawChainRow[];
  chainRowsNextWeek: RawChainRow[];
  // How many strikes around the underlying to consider per side. The
  // orchestrator may set this lower for liquidity-poor symbols.
  strikeWindowPerSide?: number;
}

// ── Public API ───────────────────────────────────────────────────────────────

export function buildSameWeekCandidates(
  input: CandidateBuildInput,
  policy: TradingPolicy,
): RollCandidate[] {
  return buildCandidatesForKind(input, policy, "SAME_WEEK");
}

export function buildNextWeekCandidates(
  input: CandidateBuildInput,
  policy: TradingPolicy,
): RollCandidate[] {
  return buildCandidatesForKind(input, policy, "NEXT_WEEK");
}

// ── Internal builder ─────────────────────────────────────────────────────────

function buildCandidatesForKind(
  input: CandidateBuildInput,
  policy: TradingPolicy,
  kind: "SAME_WEEK" | "NEXT_WEEK",
): RollCandidate[] {
  const { position } = input;
  const rows = kind === "SAME_WEEK" ? input.chainRowsThisWeek : input.chainRowsNextWeek;
  const strikeWindow = input.strikeWindowPerSide ?? 6;

  // Filter to matching contract type only.
  const sameType = rows.filter((r) => r.contractType === position.optionType);

  // Pick the strikes nearest the underlying within ±strikeWindow.
  const sortedByDistance = [...sameType].sort((a, b) =>
    Math.abs(a.strike - position.underlyingPrice) - Math.abs(b.strike - position.underlyingPrice),
  );
  const candidates = sortedByDistance.slice(0, strikeWindow * 2);

  return candidates.map((row) => buildCandidate(row, position, policy, kind));
}

function buildCandidate(
  row: RawChainRow,
  position: PositionSnapshot,
  policy: TradingPolicy,
  kind: "SAME_WEEK" | "NEXT_WEEK",
): RollCandidate {
  const spread = Math.max(0, row.ask - row.bid);

  // For LONG positions: rolling means closing current (sell at mark) +
  //   opening new (buy at row.mark). estimatedNetCredit = currentMark - newMark.
  // For SHORT positions: closing current = buy back (cost = mark) + opening
  //   new = sell (receive = newMark). estimatedNetCredit = newMark - currentMark.
  const sign = position.side === "LONG" ? 1 : -1;
  const estimatedNetCredit = sign * (position.mark - row.mark);
  const isNetDebit = estimatedNetCredit < 0;

  // Estimated profit improvement is the credit relative to the position's
  // current mark (a $0.10 credit on a $0.50 position is +20%). For SHORT
  // positions we use abs to keep semantics consistent with LONG.
  const estimatedProfitImprovementPct =
    position.mark > 0 ? estimatedNetCredit / Math.abs(position.mark) : 0;

  const positionDelta = position.delta;
  const newDelta = row.delta;
  const deltaAbsChange =
    positionDelta != null && newDelta != null
      ? newDelta - positionDelta
      : null;
  const deltaReductionPctFromCurrent =
    positionDelta != null && newDelta != null && Math.abs(positionDelta) > 0
      ? 1 - Math.abs(newDelta) / Math.abs(positionDelta)
      : null;

  // Liquidity heuristic: tight spread + nontrivial OI/volume. The exact
  // thresholds are conservative defaults — tightenable later in policy.
  const isLiquidityAcceptable =
    row.openInterest >= 50 &&
    row.volume >= 5 &&
    (row.mark > 0 ? spread / row.mark <= 0.3 : false);

  // Mark-range preservation: new mark doesn't exceed the current mark by
  // more than `policy.risk.maxRelativeMarkIncreasePct`.
  const maxAllowedRelIncrease = policy.risk.maxRelativeMarkIncreasePct ?? 0.10;
  const preservesMarkRange =
    position.mark > 0 ? row.mark <= position.mark * (1 + maxAllowedRelIncrease) : true;

  // Margin-footprint heuristic: same option type + contract size assumed
  // identical for a roll-in-place. Multi-leg or asset-class changes are
  // out of .1's scope.
  const preservesSimilarMarginFootprint = row.contractType === position.optionType;

  return {
    symbol:                       row.symbol,
    fromPositionId:               position.positionId,
    candidateType:                kind,
    newExpirationDate:            row.expirationDate,
    newStrike:                    row.strike,
    newMark:                      row.mark,
    estimatedNetCredit,
    estimatedProfitImprovementPct,
    newDelta,
    deltaAbsChange,
    deltaReductionPctFromCurrent,
    bid:                          row.bid,
    ask:                          row.ask,
    spread,
    isNetDebit,
    isLiquidityAcceptable,
    preservesSimilarMarginFootprint,
    preservesMarkRange,
  };
}
