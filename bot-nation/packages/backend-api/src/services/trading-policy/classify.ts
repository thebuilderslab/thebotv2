// R-WEEKLY-DIRECTOR.1 — deterministic regime classifiers + market-context
// builder. Verbatim regime helpers from the spec author's
// `TRADING Deterministic regime helpers.txt`, plus a small
// `buildMarketContext` factory that the orchestrator calls to assemble the
// full `MarketContextSnapshot` from raw indicator inputs.
//
// PURE FUNCTIONS. No HTTP, no DB, no Schwab. Inputs are plain objects;
// outputs are plain objects. The orchestrator in
// `services/trading/indicator-snapshot.ts` is responsible for fetching
// indicators and shaping them into `RawMarketInputs` before calling
// `buildMarketContext`.

import type {
  TrendRegime,
  VolatilityRegime,
  MarketContextSnapshot,
  TradingPolicy,
} from "./types";

// ── Regime classifier inputs ─────────────────────────────────────────────────

export interface TrendInput {
  price: number;
  ema50: number;
  ema100: number;
  ema200: number;
  rsi14: number;
  targetHigh: number;
  targetLow: number;
  hourPrice: number;
  hourEma21: number;
  hourMacdBias: "BULL" | "BEAR" | "NEUTRAL";
}

export function classifyTrendRegime(input: TrendInput): TrendRegime {
  const bull = input.price > input.ema50 && input.ema50 > input.ema100 && input.ema100 > input.ema200;
  const bear = input.price < input.ema50 && input.ema50 < input.ema100 && input.ema100 < input.ema200;

  if (bull && (input.rsi14 > 75 || input.price >= input.targetHigh)) return "BULL_EXT";
  if (bear && (input.rsi14 < 25 || input.price <= input.targetLow)) return "BEAR_EXT";
  if (bull && input.hourPrice < input.hourEma21 && input.hourMacdBias === "BEAR") return "BULL_PULLBACK";
  if (bear && input.hourPrice > input.hourEma21 && input.hourMacdBias === "BULL") return "BEAR_PULLBACK";
  if (bull) return "BULL_STRONG";
  if (bear) return "BEAR_STRONG";
  return "CHOP";
}

export function classifyVolatilityRegime(
  atrToday: number,
  atr20Avg: number,
  intradaySpike: boolean,
): VolatilityRegime {
  const ratio = atr20Avg > 0 ? atrToday / atr20Avg : 1;
  if (intradaySpike) return "VOL_HIGH_INTRADAY";
  if (ratio > 1.5) return "VOL_HIGH";
  if (ratio < 0.8) return "VOL_LOW";
  return "VOL_NORMAL";
}

// ── Market context builder ───────────────────────────────────────────────────
//
// Takes the union of raw indicator inputs the orchestrator can produce,
// classifies trend + volatility, and shapes the output into the
// `MarketContextSnapshot` consumed by `evaluatePosition`.

export interface RawMarketInputs {
  symbol: string;
  asOfIso: string;
  // Price + EMAs
  price: number;
  ema50: number;
  ema100: number;
  ema200: number;
  // Hourly EMA + MACD bias
  hourPrice: number;
  hourEma21: number;
  hourMacdBias: "BULL" | "BEAR" | "NEUTRAL";
  // Momentum + ATR
  rsi14: number;
  atr14: number;
  atr20Avg: number;
  intradaySpike: boolean;
  // Targets + prior session
  todayOpen: number;
  targetHigh: number;
  targetLow: number;
  priorHigh: number;
  priorLow: number;
  priorClose: number;
  // Calendar flags
  hasEarningsTodayOrTomorrow: boolean;
  hasMajorMacroEvent: boolean;
  // Optional 21h price-vs-EMA tag (for downstream display/audit)
  priceVsEma21h?: "ABOVE" | "BELOW" | "MIXED";
}

export function buildMarketContext(
  input: RawMarketInputs,
  // policy is accepted for symmetry with candidate/evaluate signatures and to
  // future-proof regime tuning that may read policy.volatility thresholds.
  // .1 doesn't currently consume policy here, but the parameter slot is
  // reserved so callers don't change later.
  _policy: TradingPolicy,
): MarketContextSnapshot {
  const trendRegime = classifyTrendRegime({
    price:         input.price,
    ema50:         input.ema50,
    ema100:        input.ema100,
    ema200:        input.ema200,
    rsi14:         input.rsi14,
    targetHigh:    input.targetHigh,
    targetLow:     input.targetLow,
    hourPrice:     input.hourPrice,
    hourEma21:     input.hourEma21,
    hourMacdBias:  input.hourMacdBias,
  });

  const volatilityRegime = classifyVolatilityRegime(
    input.atr14,
    input.atr20Avg,
    input.intradaySpike,
  );

  return {
    symbol:                       input.symbol,
    asOfIso:                      input.asOfIso,
    trendRegime,
    volatilityRegime,
    todayOpen:                    input.todayOpen,
    atr14:                        input.atr14,
    atr20Avg:                     input.atr20Avg,
    targetHigh:                   input.targetHigh,
    targetLow:                    input.targetLow,
    priorHigh:                    input.priorHigh,
    priorLow:                     input.priorLow,
    priorClose:                   input.priorClose,
    hasEarningsTodayOrTomorrow:   input.hasEarningsTodayOrTomorrow,
    hasMajorMacroEvent:           input.hasMajorMacroEvent,
    priceVsEma21h:                input.priceVsEma21h,
  };
}
