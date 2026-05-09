// R-WEEKLY-DIRECTOR.1 — indicator adapter.
//
// Fetches ATR/EMA/RSI/MACD bias and target highs/lows from the external
// `env.TRADING_URL` service (https://tradingagents-api-q747.onrender.com,
// already exposed as a wrangler var) and shapes the response into the
// `RawMarketInputs` consumed by `trading-policy/classify.buildMarketContext`.
//
// .1 fallback policy: if the service is unreachable / returns malformed
// data / times out, return a deterministic "neutral" fallback that
// classifies as `CHOP / VOL_NORMAL`. This guarantees the cron never
// hard-fails just because indicators are unavailable. The caller logs
// `indicatorSource: "live" | "fallback"` so the decision audit trail
// reflects which path was used.

import type { Env } from "../../index";
import type { RawMarketInputs } from "../trading-policy";

/**
 * Public shape of the result. The orchestrator reads `inputs` and feeds
 * it into `buildMarketContext`; `source` is logged as event-payload
 * metadata.
 */
export interface IndicatorSnapshot {
  source: "live" | "fallback";
  inputs: RawMarketInputs;
}

/**
 * Defaults used when the external service is unavailable. Chosen to land
 * on `CHOP / VOL_NORMAL` so candidate evaluation is still meaningful
 * (regime-permissive) but no aggressive risk-on classifications happen
 * silently. EMAs collapse to `price` so the bull/bear branches in
 * `classifyTrendRegime` short-circuit to CHOP.
 */
function fallbackInputs(symbol: string, asOfIso: string, lastPrice: number | null): RawMarketInputs {
  const price = lastPrice ?? 100; // arbitrary safe default if even the price is missing
  return {
    symbol,
    asOfIso,
    price,
    ema50:    price,
    ema100:   price,
    ema200:   price,
    hourPrice: price,
    hourEma21: price,
    hourMacdBias: "NEUTRAL",
    rsi14:    50,
    atr14:    1,
    atr20Avg: 1,
    intradaySpike: false,
    todayOpen:  price,
    targetHigh: price * 1.02,
    targetLow:  price * 0.98,
    priorHigh:  price,
    priorLow:   price,
    priorClose: price,
    hasEarningsTodayOrTomorrow: false,
    hasMajorMacroEvent: false,
  };
}

/**
 * Fetch indicators for `symbol`. Best-effort; never throws.
 *
 * `lastPrice` is supplied by the caller (typically from `fetchQuotes` on
 * the underlying) so the fallback path still has a sensible price anchor
 * even when the indicator service is unreachable.
 */
export async function fetchIndicatorSnapshot(
  env: Env,
  symbol: string,
  lastPrice: number | null,
): Promise<IndicatorSnapshot> {
  const asOfIso = new Date().toISOString();
  const baseUrl = env.TRADING_URL;
  if (!baseUrl) {
    return { source: "fallback", inputs: fallbackInputs(symbol, asOfIso, lastPrice) };
  }

  const url = `${baseUrl}/indicators?symbol=${encodeURIComponent(symbol)}`;
  let resp: Response | null = null;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    console.warn(`[indicator-snapshot] fetch threw for ${symbol}:`, err);
    return { source: "fallback", inputs: fallbackInputs(symbol, asOfIso, lastPrice) };
  }

  if (!resp.ok) {
    console.warn(`[indicator-snapshot] non-OK ${resp.status} for ${symbol}`);
    return { source: "fallback", inputs: fallbackInputs(symbol, asOfIso, lastPrice) };
  }

  let json: Record<string, unknown> | null = null;
  try {
    json = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    console.warn(`[indicator-snapshot] JSON parse failed for ${symbol}:`, err);
    return { source: "fallback", inputs: fallbackInputs(symbol, asOfIso, lastPrice) };
  }

  // Defensive coercion. The external service shape is documented elsewhere;
  // .1 only consumes a small subset and falls back per-field if any value
  // is missing or non-numeric.
  const num = (key: string, dflt: number): number => {
    const v = json?.[key];
    return typeof v === "number" && Number.isFinite(v) ? v : dflt;
  };
  const bool = (key: string, dflt: boolean): boolean => {
    const v = json?.[key];
    return typeof v === "boolean" ? v : dflt;
  };
  const macdRaw = json?.["hourMacdBias"];
  const hourMacdBias: "BULL" | "BEAR" | "NEUTRAL" =
    macdRaw === "BULL" || macdRaw === "BEAR" || macdRaw === "NEUTRAL" ? macdRaw : "NEUTRAL";

  const price = num("price", lastPrice ?? 100);

  const inputs: RawMarketInputs = {
    symbol,
    asOfIso,
    price,
    ema50:    num("ema50",  price),
    ema100:   num("ema100", price),
    ema200:   num("ema200", price),
    hourPrice: num("hourPrice", price),
    hourEma21: num("hourEma21", price),
    hourMacdBias,
    rsi14:    num("rsi14", 50),
    atr14:    num("atr14", 1),
    atr20Avg: num("atr20Avg", 1),
    intradaySpike: bool("intradaySpike", false),
    todayOpen:  num("todayOpen",  price),
    targetHigh: num("targetHigh", price * 1.02),
    targetLow:  num("targetLow",  price * 0.98),
    priorHigh:  num("priorHigh",  price),
    priorLow:   num("priorLow",   price),
    priorClose: num("priorClose", price),
    hasEarningsTodayOrTomorrow: bool("hasEarningsTodayOrTomorrow", false),
    hasMajorMacroEvent:         bool("hasMajorMacroEvent", false),
  };

  return { source: "live", inputs };
}
