/**
 * Probability Engine — Phase A.7 (Layer 3 of the Finance-Intelligence layered
 * recommendation engine).
 *
 * Estimates P(underlying touches target within horizon) for option positions
 * and watchlist symbols. Primary method: IV-informed Monte Carlo (10k GBM paths).
 * Fallback: realized-vol Monte Carlo over the same path generator when no recent
 * IV is available.
 *
 * Touch definition: "hit target" = max(S_0..S_T) ≥ target_up OR
 * min(S_0..S_T) ≤ target_down — intraday touch, not close-through.
 *
 * Reads: position_snapshots, watchlist_snapshots.
 * Writes: nothing.
 * Forbidden: external API calls, Telegram, order staging, ML beyond GBM.
 *
 * Single seed source: every Monte Carlo run in the system seeds its PRNG from
 * `makeMonteCarloSeed(symbol, target, horizon_days, date)`. No other module
 * may generate seeds for stochastic computation.
 */

import { query, queryOne } from "../db/schema";

// ── Public types ─────────────────────────────────────────────────────────────

export interface ProbabilityInput {
  symbol: string;
  target_up?: number;
  target_down?: number;
  horizons_days: number[];
  /** Test override; in production callers omit this. */
  seed?: number;
}

export interface ProbabilityResult {
  symbol: string;
  spot: number;
  target: number;
  direction: "up" | "down";
  horizon_days: number;
  probability: number;          // in [0, 1]
  method: "iv_mc" | "realized_vol";
  paths_simulated: number;
  source_iv: number | null;
  realized_sigma: number | null;
  computed_at: string;          // UTC ISO
}

export interface ProbabilityEngine {
  estimateTargetHit(db: D1Database, input: ProbabilityInput): Promise<ProbabilityResult[]>;
}

export class InsufficientHistory extends Error {
  constructor(symbol: string, detail: string) {
    super(`Insufficient history for ${symbol}: ${detail}`);
    this.name = "InsufficientHistory";
  }
}

// ── Constants ────────────────────────────────────────────────────────────────

export const PATHS_SIMULATED = 10_000;
export const TRADING_DAYS_PER_YEAR = 252;
const REALIZED_VOL_LOOKBACK_DAYS = 60;       // calendar days, expects ≥30 trading days
const MIN_REALIZED_OBSERVATIONS = 30;

// ── Single source of seeds (sync, deterministic FNV-1a 32-bit) ──────────────

/**
 * Deterministic 32-bit hash for Monte Carlo seeding. FNV-1a chosen for sync
 * implementation in Workers (no Web Crypto required). The exact hash family
 * is an implementation detail; only `(input → same u32 → same probability)`
 * is part of the public contract.
 *
 * No other module may generate Monte Carlo seeds.
 */
export function makeMonteCarloSeed(
  symbol: string,
  target: number,
  horizon_days: number,
  date: string,
): number {
  const input = `${symbol}|${target}|${horizon_days}|${date}`;
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    // FNV prime 16777619, kept inside u32 via Math.imul
    h = Math.imul(h, 0x01000193);
  }
  // Force unsigned 32-bit result.
  return h >>> 0;
}

// ── Deterministic PRNG (linear congruential, Numerical Recipes constants) ───

interface Prng {
  /** Uniform [0, 1). */
  next(): number;
  /** Standard normal via Box-Muller. */
  nextNormal(): number;
}

function makePrng(seed: number): Prng {
  let state = (seed >>> 0) || 1; // never seed 0
  let cachedNormal: number | null = null;

  const next = (): number => {
    // Numerical Recipes constants — full-period 32-bit LCG.
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };

  const nextNormal = (): number => {
    if (cachedNormal !== null) {
      const v = cachedNormal;
      cachedNormal = null;
      return v;
    }
    // Box-Muller; guard against u=0 producing -Infinity.
    let u1 = next();
    while (u1 <= 1e-12) u1 = next();
    const u2 = next();
    const mag = Math.sqrt(-2 * Math.log(u1));
    const z0 = mag * Math.cos(2 * Math.PI * u2);
    const z1 = mag * Math.sin(2 * Math.PI * u2);
    cachedNormal = z1;
    return z0;
  };

  return { next, nextNormal };
}

// ── Pure GBM Monte Carlo ─────────────────────────────────────────────────────

/**
 * Simulate `paths` GBM paths for `horizon_days` daily steps and return the
 * fraction of paths where the running extremum touches the target.
 *
 * For an upside target (target > spot), counts paths whose running max ever
 * reaches or exceeds the target. For a downside target (target < spot),
 * counts paths whose running min ever reaches or falls below the target.
 *
 * Spec §5: "touch", not close-through. Daily step size, r=0, annualized σ.
 */
export function monteCarloHit(args: {
  spot: number;
  target: number;
  sigma: number;            // annualized
  horizon_days: number;
  paths: number;
  seed: number;
}): number {
  const { spot, target, sigma, horizon_days, paths, seed } = args;
  if (spot <= 0) throw new Error("spot must be positive");
  if (sigma < 0) throw new Error("sigma must be non-negative");
  if (horizon_days <= 0) throw new Error("horizon_days must be positive");
  if (paths <= 0) throw new Error("paths must be positive");
  if (target <= 0) throw new Error("target must be positive");

  const prng = makePrng(seed);
  const dt = 1 / TRADING_DAYS_PER_YEAR;
  const drift = -0.5 * sigma * sigma * dt;
  const diffusion = sigma * Math.sqrt(dt);
  const direction: "up" | "down" = target >= spot ? "up" : "down";

  let hits = 0;
  for (let p = 0; p < paths; p++) {
    let price = spot;
    let touched = direction === "up" ? price >= target : price <= target;
    for (let d = 0; d < horizon_days && !touched; d++) {
      const z = prng.nextNormal();
      price = price * Math.exp(drift + diffusion * z);
      touched = direction === "up" ? price >= target : price <= target;
    }
    if (touched) hits++;
  }
  return hits / paths;
}

// ── Realized-vol helper (pure over an array of closes) ──────────────────────

/**
 * Annualized realized volatility from a chronological close-price series.
 * Computes log returns, then sample stddev × √252.
 *
 * Throws when there are not enough observations to compute a return-series
 * sample variance (n ≥ MIN_REALIZED_OBSERVATIONS + 1).
 */
export function computeRealizedVol(closes: number[]): number {
  if (closes.length < MIN_REALIZED_OBSERVATIONS + 1) {
    throw new Error(`need ≥${MIN_REALIZED_OBSERVATIONS + 1} closes; got ${closes.length}`);
  }
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    const cur = closes[i]!;
    if (prev <= 0 || cur <= 0) continue;
    returns.push(Math.log(cur / prev));
  }
  if (returns.length < MIN_REALIZED_OBSERVATIONS) {
    throw new Error(`need ≥${MIN_REALIZED_OBSERVATIONS} return observations`);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, r) => a + (r - mean) * (r - mean), 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

// ── DB-backed lookups ────────────────────────────────────────────────────────

interface IVLookup {
  iv: number;
  spot: number;
}

/**
 * Fetch the latest position_snapshots row for `symbol` with non-null IV that
 * is recent (created_at within the last 1 day) and not flagged as failed.
 * Returns null when none qualifies.
 */
async function getLatestSnapshotIV(db: D1Database, symbol: string): Promise<IVLookup | null> {
  const row = await queryOne<{ iv: number; spot: number }>(
    db,
    `SELECT implied_volatility AS iv, underlying_price AS spot
       FROM position_snapshots
      WHERE symbol = ?
        AND implied_volatility IS NOT NULL
        AND COALESCE(enrichment_failed, 0) = 0
        AND created_at >= datetime('now', '-1 day')
      ORDER BY created_at DESC
      LIMIT 1`,
    [symbol],
  );
  if (!row || row.iv == null || row.spot == null || row.spot <= 0 || row.iv <= 0) return null;
  return { iv: row.iv, spot: row.spot };
}

/**
 * Fetch one underlying close per trading day for `symbol` over the last
 * REALIZED_VOL_LOOKBACK_DAYS calendar days. Prefers position_snapshots
 * (underlying_price); falls back to watchlist_snapshots (close_price) when
 * the symbol is not in held positions. De-duplicated to one row per day.
 *
 * Returns chronologically-ordered closes (oldest first). May return fewer
 * than MIN_REALIZED_OBSERVATIONS + 1 entries; caller handles that.
 */
async function get30DayCloses(db: D1Database, symbol: string): Promise<{ closes: number[]; spot: number | null }> {
  // 1) Try position_snapshots first.
  let rows = await query<{ d: string; close: number }>(
    db,
    `SELECT date(created_at) AS d,
            underlying_price AS close
       FROM (
         SELECT created_at, underlying_price,
                ROW_NUMBER() OVER (PARTITION BY date(created_at) ORDER BY created_at DESC) AS rn
           FROM position_snapshots
          WHERE symbol = ?
            AND underlying_price IS NOT NULL
            AND underlying_price > 0
            AND created_at >= datetime('now', ?)
       )
      WHERE rn = 1
      ORDER BY d ASC`,
    [symbol, `-${REALIZED_VOL_LOOKBACK_DAYS} days`],
  );

  if (rows.length < MIN_REALIZED_OBSERVATIONS + 1) {
    // 2) Fall back to watchlist_snapshots.
    rows = await query<{ d: string; close: number }>(
      db,
      `SELECT date(recorded_at) AS d, close_price AS close
         FROM watchlist_snapshots
        WHERE symbol = ?
          AND close_price > 0
          AND recorded_at >= datetime('now', ?)
        ORDER BY d ASC`,
      [symbol, `-${REALIZED_VOL_LOOKBACK_DAYS} days`],
    );
  }

  const closes = rows.map((r) => r.close).filter((c) => typeof c === "number" && c > 0);
  const spot = closes.length > 0 ? closes[closes.length - 1]! : null;
  return { closes, spot };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

function shapeResult(args: {
  symbol: string;
  spot: number;
  target: number;
  direction: "up" | "down";
  horizon_days: number;
  probability: number;
  method: "iv_mc" | "realized_vol";
  source_iv: number | null;
  realized_sigma: number | null;
}): ProbabilityResult {
  return {
    symbol: args.symbol,
    spot: args.spot,
    target: args.target,
    direction: args.direction,
    horizon_days: args.horizon_days,
    probability: args.probability,
    method: args.method,
    paths_simulated: PATHS_SIMULATED,
    source_iv: args.source_iv,
    realized_sigma: args.realized_sigma,
    computed_at: new Date().toISOString(),
  };
}

/**
 * Entry point. For every (target, horizon) combination in `input`, produce
 * one ProbabilityResult. Uses IV-MC when a recent IV snapshot exists for the
 * symbol; otherwise falls back to realized-vol over the same path generator.
 * Throws InsufficientHistory if neither source is available.
 */
export async function estimateTargetHit(
  db: D1Database,
  input: ProbabilityInput,
): Promise<ProbabilityResult[]> {
  const targets: Array<{ target: number; direction: "up" | "down" }> = [];
  if (typeof input.target_up === "number") targets.push({ target: input.target_up, direction: "up" });
  if (typeof input.target_down === "number") targets.push({ target: input.target_down, direction: "down" });
  if (targets.length === 0) {
    throw new Error("estimateTargetHit: at least one of target_up / target_down is required");
  }
  if (input.horizons_days.length === 0) {
    throw new Error("estimateTargetHit: horizons_days must contain ≥1 horizon");
  }

  // Try IV first.
  const ivLookup = await getLatestSnapshotIV(db, input.symbol);

  let realizedSigma: number | null = null;
  let realizedSpot: number | null = null;
  if (!ivLookup) {
    const { closes, spot } = await get30DayCloses(db, input.symbol);
    try {
      realizedSigma = computeRealizedVol(closes);
      realizedSpot = spot;
    } catch (err) {
      // Either zero IV history AND zero realized history → fail loud.
      throw new InsufficientHistory(
        input.symbol,
        `no recent IV and realized-vol computation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!realizedSpot) {
      throw new InsufficientHistory(input.symbol, "no spot price available from snapshots");
    }
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const out: ProbabilityResult[] = [];

  for (const { target, direction } of targets) {
    for (const horizon_days of input.horizons_days) {
      const seed = input.seed ?? makeMonteCarloSeed(input.symbol, target, horizon_days, todayIso);
      if (ivLookup) {
        const probability = monteCarloHit({
          spot: ivLookup.spot,
          target,
          sigma: ivLookup.iv,
          horizon_days,
          paths: PATHS_SIMULATED,
          seed,
        });
        out.push(shapeResult({
          symbol: input.symbol,
          spot: ivLookup.spot,
          target,
          direction,
          horizon_days,
          probability,
          method: "iv_mc",
          source_iv: ivLookup.iv,
          realized_sigma: null,
        }));
      } else {
        const probability = monteCarloHit({
          spot: realizedSpot!,
          target,
          sigma: realizedSigma!,
          horizon_days,
          paths: PATHS_SIMULATED,
          seed,
        });
        out.push(shapeResult({
          symbol: input.symbol,
          spot: realizedSpot!,
          target,
          direction,
          horizon_days,
          probability,
          method: "realized_vol",
          source_iv: null,
          realized_sigma: realizedSigma,
        }));
      }
    }
  }

  return out;
}
