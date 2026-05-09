// R-WEEKLY-DIRECTOR.1 — orchestrator (dry-run only).
//
// Loads positions from D1, fetches market context + option chains via the
// existing schwab-positions adapter, builds candidates via the pure-core
// `trading-policy/` module, evaluates per-position decisions, emits a
// structured event trail, and posts a FULL_DEBUG Telegram summary.
//
// .1 INVARIANT: this function NEVER places live orders. `mode` is accepted
// to keep the signature stable for .2 (`mode="live"` will be added there),
// but .1 ignores anything except `dry_run` and explicitly logs the
// guard.
//
// All deterministic logic lives in `trading-policy/`. This file is the
// thin shell that wires data fetching + event emission + Telegram around
// those pure functions.

import type { Env } from "../../index";
import { run } from "../../db/schema";
import { getStoredPositions, fetchOptionsChain, fetchQuotes } from "../schwab-positions";
import {
  WEEKLY_OPTIONS_POLICY_V1,
  buildMarketContext,
  buildNextWeekCandidates,
  buildSameWeekCandidates,
  evaluateAccount,
  type AccountSnapshot,
  type MarketContextSnapshot,
  type PositionSnapshot,
  type RollCandidate,
  type WeeklyAccountDecision,
  type RawChainRow,
} from "../trading-policy";
import { fetchIndicatorSnapshot } from "./indicator-snapshot";
import { escapeAgentHtml, chunkPreRenderedTelegramHtml, stripHtmlToPlain } from "../../utils/telegram-format";

export type DirectorMode = "dry_run" | "live";

export interface DirectorRunResult {
  ok: boolean;
  weeklyCycleId: string;
  accountId: string;
  mode: DirectorMode;
  decisionCount: number;
  holdCount: number;
  rollSelectedCount: number;
  closeCount: number;
  durationMs: number;
  indicatorSource: "live" | "fallback" | "mixed";
  reason?: string;
}

/**
 * Public entry point for the orchestrator. R-WEEKLY-DIRECTOR.1 hard-codes
 * `mode="dry_run"` regardless of caller input — the guard at the top of
 * this function is the SINGLE place that decides whether live execution
 * happens, and .1 always answers "no". .2 will replace this guard.
 */
export async function runWeeklyOptionsDirector(
  env: Env,
  accountId: string,
  modeRequested: DirectorMode,
): Promise<DirectorRunResult> {
  const weeklyCycleId = crypto.randomUUID();
  const startedAtIso = new Date().toISOString();
  const startedAtMs = Date.now();

  // Hard guard: .1 only runs in dry_run mode. Even if modeRequested === "live"
  // we coerce to dry_run and log it so the operator audit trail is honest.
  const mode: DirectorMode = "dry_run";
  if (modeRequested !== "dry_run") {
    console.warn(
      `[weekly-options-director] requested mode=${modeRequested} forced to dry_run (R-WEEKLY-DIRECTOR.1 invariant)`,
    );
  }

  const policy = WEEKLY_OPTIONS_POLICY_V1;

  await emit(env, "director.weekly_cycle_started", accountId, {
    weeklyCycleId,
    accountId,
    mode,
    modeRequested,
    policyVersion: policy.version,
    startedAtIso,
  });

  // ── 1. Load positions ─────────────────────────────────────────────────────
  const stored = await getStoredPositions(env.DB);
  const positionsForAccount = stored.positions.filter((p) =>
    accountIdMatches(accountId, p.account_number),
  );

  if (positionsForAccount.length === 0) {
    const result: DirectorRunResult = {
      ok: true,
      weeklyCycleId,
      accountId,
      mode,
      decisionCount: 0,
      holdCount: 0,
      rollSelectedCount: 0,
      closeCount: 0,
      durationMs: Date.now() - startedAtMs,
      indicatorSource: "fallback",
      reason: "no_positions_for_account",
    };
    await emit(env, "director.weekly_cycle_completed", accountId, { ...result });
    return result;
  }

  // Filter to options only — equities are out of .1's scope.
  const optionPositionsRaw = positionsForAccount.filter((p) => p.asset_type === "OPTION");
  const positions: PositionSnapshot[] = optionPositionsRaw.map((p) =>
    storedRowToSnapshot(p, accountId, stored.synced_at),
  );

  // ── 2. Build market context per held underlying ──────────────────────────
  const heldUnderlyings = uniq(positions.map((p) => deriveUnderlying(p.symbol)));
  const marketByUnderlying: Record<string, MarketContextSnapshot> = {};
  let liveCount = 0;
  let fallbackCount = 0;

  // Get live quotes once for all underlyings; gives the indicator adapter
  // a price anchor for its fallback path.
  const clientId = env.SCHWAB_CLIENT_ID;
  const clientSecret = env.SCHWAB_CLIENT_SECRET;
  const quotesByUnderlying: Record<string, number | null> = {};
  if (clientId && clientSecret && heldUnderlyings.length > 0) {
    try {
      const quotes = await fetchQuotes(env.DB, clientId, clientSecret, heldUnderlyings);
      for (const q of quotes) {
        quotesByUnderlying[q.symbol] = q.last_price;
      }
    } catch (err) {
      console.warn("[weekly-options-director] fetchQuotes failed:", err);
    }
  }

  for (const sym of heldUnderlyings) {
    const lastPrice = quotesByUnderlying[sym] ?? null;
    const snapshot = await fetchIndicatorSnapshot(env, sym, lastPrice);
    if (snapshot.source === "live") liveCount++;
    else fallbackCount++;
    marketByUnderlying[sym] = buildMarketContext(snapshot.inputs, policy);
  }

  const indicatorSource: "live" | "fallback" | "mixed" =
    liveCount > 0 && fallbackCount > 0 ? "mixed" : liveCount > 0 ? "live" : "fallback";

  // ── 3. Build candidates per position ──────────────────────────────────────
  // R-WEEKLY-DIRECTOR.1.2: enrich each PositionSnapshot's `delta` and
  // `underlyingPrice` from the freshly-fetched chain rows + live quote
  // BEFORE building candidates. Pre-1.2 these were null/0 because the
  // schwab_positions table doesn't store option deltas — which made every
  // candidate fail DELTA_RULE_FAILED in evaluateCandidate (delta math
  // requires a non-null position.delta) and forced every position to HOLD.
  // Now that we already fetch the chain per-position to build candidates,
  // sourcing the position's own delta from the matching contract row is
  // essentially free.
  const candidatesByPosition: Record<
    string,
    { nextWeek: RollCandidate[]; sameWeek: RollCandidate[] }
  > = {};

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i]!;
    const underlying = deriveUnderlying(pos.symbol);
    let nextWeekRows: RawChainRow[] = [];
    let sameWeekRows: RawChainRow[] = [];

    if (clientId && clientSecret) {
      try {
        // R-WEEKLY-DIRECTOR.1.3: anchor the chain fetch + window
        // partitioning on the POSITION'S OWN expiry, not on today's
        // calendar. fromDate/toDate constrain Schwab's response so we
        // get rows for the position-week + 3 forward weeks (no wasted
        // bandwidth on irrelevant near-term expirations).
        const win = positionExpiryWindows(pos.expirationDate);
        const chain = await fetchOptionsChain(env.DB, clientId, clientSecret, underlying, {
          contractType: pos.optionType,
          strikeCount: 12,
          fromDate: win.fromDate,
          toDate:   win.toDate,
        });
        const rows: RawChainRow[] = (
          pos.optionType === "CALL" ? chain.calls : chain.puts
        ).map((c) => ({
          symbol: c.symbol,
          strike: c.strike,
          expirationDate: c.expiration,
          bid: c.bid,
          ask: c.ask,
          mark: c.mark,
          delta: c.delta,
          volume: c.volume,
          openInterest: c.open_interest,
          contractType: c.contract_type,
          dte: c.dte,
        }));

        // Same-week candidates (used by buildSameWeekCandidates for
        // backward-repair candidates in current .1 logic; .2 will gate
        // these with BACKWARD_ROLL_REJECTED unless repair conditions
        // hold). Covers both the position's own expiry date AND the
        // Friday of that week (Thursday-monthlies + Friday-weeklies).
        sameWeekRows = rows.filter((r) => win.sameWeekDates.includes(r.expirationDate));

        // Forward candidates: next Friday after position-week + 2 + 3.
        nextWeekRows = rows.filter(
          (r) => r.expirationDate === win.nextWeek1
              || r.expirationDate === win.nextWeek2
              || r.expirationDate === win.nextWeek3,
        );

        // R-WEEKLY-DIRECTOR.1.2: enrich position delta + underlying price
        // from the fetched chain. Pass full `rows` so the position's
        // contract is matched by (optionType, strike, expirationDate).
        positions[i] = enrichPositionFromChain(
          pos,
          rows,
          quotesByUnderlying[underlying] ?? null,
        );
      } catch (err) {
        console.warn(`[weekly-options-director] options chain failed for ${underlying}:`, err);
      }
    }

    // Use the (possibly enriched) position when building candidates.
    const enrichedPos = positions[i]!;
    candidatesByPosition[enrichedPos.positionId] = {
      nextWeek: buildNextWeekCandidates(
        { position: enrichedPos, chainRowsThisWeek: sameWeekRows, chainRowsNextWeek: nextWeekRows },
        policy,
      ),
      sameWeek: buildSameWeekCandidates(
        { position: enrichedPos, chainRowsThisWeek: sameWeekRows, chainRowsNextWeek: nextWeekRows },
        policy,
      ),
    };
  }

  // ── 4. Evaluate per-position decisions ────────────────────────────────────
  const accountSnap: AccountSnapshot = {
    accountId,
    timestampIso: startedAtIso,
  };
  const decision: WeeklyAccountDecision = evaluateAccount(
    policy,
    accountSnap,
    positions,
    marketByUnderlying,
    candidatesByPosition,
    weeklyCycleId,
    startedAtIso,
  );

  // ── 5. Emit per-position events ───────────────────────────────────────────
  let holdCount = 0;
  let rollSelectedCount = 0;
  let closeCount = 0;

  for (const d of decision.decisions) {
    await emit(env, "director.position_evaluated", accountId, {
      weeklyCycleId,
      accountId,
      positionId: d.positionId,
      symbol: d.symbol,
      selectedAction: d.selectedAction,
      primaryReason: d.primaryReason,
      reasons: d.reasons,
      chosenCandidate: d.chosenCandidate
        ? {
            candidateType: d.chosenCandidate.candidateType,
            newStrike: d.chosenCandidate.newStrike,
            newExpiration: d.chosenCandidate.newExpirationDate,
            estimatedNetCredit: d.chosenCandidate.estimatedNetCredit,
            estimatedProfitImprovementPct: d.chosenCandidate.estimatedProfitImprovementPct,
            deltaReductionPctFromCurrent: d.chosenCandidate.deltaReductionPctFromCurrent,
          }
        : undefined,
      rejectedCount: d.rejectedCandidates.length,
    });

    for (const rej of d.rejectedCandidates.filter((e) => !e.eligible)) {
      await emit(env, "director.roll_candidate_rejected", accountId, {
        weeklyCycleId,
        accountId,
        positionId: d.positionId,
        symbol: d.symbol,
        candidateType: rej.candidate.candidateType,
        strike: rej.candidate.newStrike,
        expirationDate: rej.candidate.newExpirationDate,
        rejectionReasons: rej.rejectionReasons,
      });
    }

    if (d.selectedAction === "ROLL_NEXT_WEEK" || d.selectedAction === "ROLL_SAME_WEEK") {
      rollSelectedCount++;
      if (d.chosenCandidate) {
        await emit(env, "director.roll_selected_preview", accountId, {
          weeklyCycleId,
          accountId,
          positionId: d.positionId,
          symbol: d.symbol,
          candidateType: d.chosenCandidate.candidateType,
          newStrike: d.chosenCandidate.newStrike,
          newExpiration: d.chosenCandidate.newExpirationDate,
          estimatedNetCredit: d.chosenCandidate.estimatedNetCredit,
          deltaReductionPctFromCurrent: d.chosenCandidate.deltaReductionPctFromCurrent,
        });
      }
    } else if (d.selectedAction === "CLOSE") {
      closeCount++;
    } else {
      holdCount++;
    }
  }

  // ── 6. Telegram FULL_DEBUG summary ────────────────────────────────────────
  await sendTelegramSummary(env, decision, indicatorSource);

  // ── 7. Cycle complete ────────────────────────────────────────────────────
  const result: DirectorRunResult = {
    ok: true,
    weeklyCycleId,
    accountId,
    mode,
    decisionCount: decision.decisions.length,
    holdCount,
    rollSelectedCount,
    closeCount,
    durationMs: Date.now() - startedAtMs,
    indicatorSource,
  };
  await emit(env, "director.weekly_cycle_completed", accountId, { ...result });
  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

/**
 * R-WEEKLY-DIRECTOR.1.2: enrich a PositionSnapshot's `delta` and
 * `underlyingPrice` from a freshly-fetched option chain + live underlying
 * quote. Pure function — exported for fixture testability.
 *
 * Pre-1.2 behavior: storedRowToSnapshot left these as null/0 because the
 * `schwab_positions` D1 table doesn't store option Greeks. evaluateCandidate
 * then rejected every roll candidate with DELTA_RULE_FAILED (delta math
 * requires non-null position.delta). Result: every position evaluated to
 * HOLD/REGIME_HOLD regardless of actual chain conditions — honest output,
 * but uninformative.
 *
 * Post-1.2 behavior: orchestrator already fetches the per-position chain
 * to build candidates. We match the position's specific contract by
 * (optionType, strike, expirationDate) and pull its live `delta`. Same
 * pass injects the live underlying price from the quote fetch (used by
 * candidates.ts to sort strikes by distance from the underlying).
 *
 * Returns a NEW PositionSnapshot rather than mutating in place. Defensive:
 * if no matching chain row exists or its delta is null, the original
 * position.delta is preserved (typically null). Same for underlyingPrice.
 */
export function enrichPositionFromChain(
  position: PositionSnapshot,
  chainRows: { contractType: "CALL" | "PUT"; strike: number; expirationDate: string; delta: number | null }[],
  underlyingPrice: number | null,
): PositionSnapshot {
  const match = chainRows.find(
    (r) =>
      r.contractType === position.optionType &&
      r.strike === position.strike &&
      r.expirationDate === position.expirationDate,
  );
  return {
    ...position,
    delta: match?.delta ?? position.delta,
    underlyingPrice:
      underlyingPrice != null && Number.isFinite(underlyingPrice) && underlyingPrice > 0
        ? underlyingPrice
        : position.underlyingPrice,
  };
}


async function emit(
  env: Env,
  kind: string,
  accountId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await run(
      env.DB,
      `INSERT INTO events (id, kind, actor_id, target_kind, target_id, payload, session_id, created_at, updated_at)
       VALUES (?, ?, NULL, 'account', ?, ?, NULL, ?, ?)`,
      [id, kind, accountId, JSON.stringify(payload), now, now],
    );
  } catch (err) {
    console.warn(`[weekly-options-director] event emit failed (${kind}):`, err);
  }
}

interface StoredPositionRow {
  account_number: string;
  symbol: string;
  asset_type: string;
  quantity: number;
  average_price: number;
  market_value: number;
  cost_basis: number;
  unrealized_pnl: number;
  current_day_pnl: number;
  current_day_pnl_pct: number;
  description?: string;
  synced_at: string;
}

function storedRowToSnapshot(
  row: StoredPositionRow,
  accountId: string,
  syncedAt: string | null,
): PositionSnapshot {
  // OCC symbol parse: "GOOGL 260618C00430000" → strike=430, expiry=2026-06-18, type=CALL
  const occ = parseOccSymbol(row.symbol);
  const strike = occ?.strike ?? 0;
  const expirationDate = occ?.expirationDate ?? "";
  const optionType = (occ?.optionType ?? "CALL") as "CALL" | "PUT";
  const daysToExpiry = expirationDate ? Math.max(0, daysBetween(new Date(), new Date(expirationDate))) : 0;
  const pnlPct = row.cost_basis !== 0 ? row.unrealized_pnl / Math.abs(row.cost_basis) : 0;

  // R-WEEKLY-DIRECTOR.1.1 fix: PositionSnapshot.symbol per spec is the
  // UNDERLYING TICKER (e.g. "GOOGL"), NOT the OCC contract symbol. The
  // first dry-run on 2026-05-09 produced PRECHECK_FAILED for every
  // position because evaluateAccount looks up
  // marketByUnderlying[position.symbol] expecting the underlying, but
  // we were storing the OCC string here. The contract is identified by
  // (symbol, optionType, strike, expirationDate) — no separate OCC
  // field needed for .1's dry-run flow.
  return {
    accountId,
    symbol:        deriveUnderlying(row.symbol),
    positionId:    `pos-${accountId}-${row.symbol.replace(/\s+/g, "-")}`,
    optionType,
    side:          row.quantity >= 0 ? "LONG" : "SHORT",
    quantity:      Math.abs(row.quantity),
    strike,
    expirationDate,
    mark:          row.cost_basis !== 0 ? row.market_value / 100 / Math.abs(row.quantity || 1) : row.market_value,
    delta:         null, // not stored in schwab_positions; orchestrator could fetch later
    pnlPct,
    daysToExpiry,
    underlyingPrice: 0, // filled by quote fetch later in cycle when needed
    strategyTag:   row.description ?? null,
  };
}

function deriveUnderlying(occSymbol: string): string {
  const m = occSymbol.match(/^([A-Z]{1,6})\s*\d{6}[CP]\d{8}$/);
  return m?.[1] ?? occSymbol.split(/\s+/)[0] ?? occSymbol;
}

function parseOccSymbol(occ: string): { strike: number; expirationDate: string; optionType: "CALL" | "PUT" } | null {
  // OCC: SYMBOL[space-padded]YYMMDD[C|P]NNNNNNNN  (strike in thousandths of a dollar × 1000)
  const m = occ.match(/^([A-Z]{1,6})\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  const yy = m[2]!;
  const mm = m[3]!;
  const dd = m[4]!;
  const cp = m[5]!;
  const strikeRaw = m[6]!;
  return {
    strike: parseInt(strikeRaw, 10) / 1000,
    expirationDate: `20${yy}-${mm}-${dd}`,
    optionType: cp === "C" ? "CALL" : "PUT",
  };
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

// R-WEEKLY-DIRECTOR.1.3: position-expiry-relative window math.
//
// Pre-1.3 the orchestrator computed `thisFriday` / `nextFriday` from TODAY's
// calendar, which produced wrong-week chain rows for any position that
// doesn't expire in the current calendar week. Live dry run #3 (cycle
// `7460f2aa`) selected `GOOGL 410C 2026-05-15` for a position expiring
// `2026-06-18` — 5 weeks BEFORE the position's own expiry. All 24
// rejected candidates also had expirationDate `2026-05-15`.
//
// Post-1.3: same/next-week windows are anchored on each position's own
// expiration date. Forward candidate weeks = position-week-Friday +7,
// +14, +21 days. Same-week (used for backward-repair only) covers both
// the position's own expiry date AND the Friday of that week (handles
// Thursday-monthlies + Friday-weeklies).
//
// PURE FUNCTION. Exported for fixture testability. No DB / HTTP / Schwab
// inside.

export interface PositionExpiryWindows {
  positionExpiry:     string;     // e.g. "2026-06-18"
  positionWeekFriday: string;     // Friday of that week (e.g. "2026-06-19")
  sameWeekDates:      string[];   // [positionExpiry, positionWeekFriday], deduped
  nextWeek1:          string;     // positionWeekFriday + 7
  nextWeek2:          string;     // + 14
  nextWeek3:          string;     // + 21
  fromDate:           string;     // for fetchOptionsChain — == positionExpiry
  toDate:             string;     // for fetchOptionsChain — == nextWeek3
}

export function positionExpiryWindows(positionExpirationDate: string): PositionExpiryWindows {
  const base = new Date(positionExpirationDate + "T00:00:00Z");
  const day = base.getUTCDay();              // 0=Sun..6=Sat, Friday=5
  const offsetToFriday = ((5 - day) + 7) % 7; // 0 if already Friday
  const positionWeekFriday = addDaysIso(positionExpirationDate, offsetToFriday);
  const sameWeekDates = [positionExpirationDate, positionWeekFriday]
    .filter((d, i, arr) => arr.indexOf(d) === i); // dedup if Friday-expiry
  return {
    positionExpiry:    positionExpirationDate,
    positionWeekFriday,
    sameWeekDates,
    nextWeek1: addDaysIso(positionWeekFriday, 7),
    nextWeek2: addDaysIso(positionWeekFriday, 14),
    nextWeek3: addDaysIso(positionWeekFriday, 21),
    fromDate:  positionExpirationDate,
    toDate:    addDaysIso(positionWeekFriday, 21),
  };
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function accountIdMatches(accountId: string, accountNumber: string): boolean {
  // Accept both full ID matches and last-4 matches (`accountNumber` is the
  // last-4 hash from schwab-positions.ts).
  return accountId === accountNumber || accountId.endsWith(accountNumber);
}

async function sendTelegramSummary(
  env: Env,
  decision: WeeklyAccountDecision,
  indicatorSource: "live" | "fallback" | "mixed",
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  const dateLabel = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push(`🎯 <b>Weekly Options Director — ${escapeAgentHtml(dateLabel)} — DRY RUN</b>`);
  lines.push("");
  lines.push(`Policy: <code>weekly-options-v1</code>`);
  lines.push(`Account: <code>${escapeAgentHtml(decision.accountId)}</code>`);
  lines.push(`Cycle: <code>${escapeAgentHtml(decision.weeklyCycleId)}</code>`);
  lines.push(`Indicators: <i>${escapeAgentHtml(indicatorSource)}</i>`);
  lines.push("");
  lines.push(`<b>Per-position decisions (${decision.decisions.length}):</b>`);

  decision.decisions.forEach((d, i) => {
    lines.push(
      `${i + 1}. <b>${escapeAgentHtml(d.symbol)}</b> · ${escapeAgentHtml(d.selectedAction)} (${escapeAgentHtml(d.primaryReason)})`,
    );
    if (d.chosenCandidate) {
      const c = d.chosenCandidate;
      const profit = (c.estimatedProfitImprovementPct * 100).toFixed(1);
      const dRed = c.deltaReductionPctFromCurrent != null ? (c.deltaReductionPctFromCurrent * 100).toFixed(1) : "—";
      lines.push(
        `   chosen: ${escapeAgentHtml(c.candidateType)} ${c.newStrike}@${escapeAgentHtml(c.newExpirationDate)}, +${profit}%, Δred ${dRed}%`,
      );
    } else if (d.rejectedCandidates.length > 0) {
      lines.push(`   rejected: ${d.rejectedCandidates.length} candidates`);
    }
  });

  lines.push("");
  const counts = decision.decisions.reduce(
    (acc, d) => {
      if (d.selectedAction === "HOLD") acc.h++;
      else if (d.selectedAction === "CLOSE") acc.c++;
      else acc.r++;
      return acc;
    },
    { h: 0, r: 0, c: 0 },
  );
  lines.push(`<b>Cycle:</b> ${counts.h} holds, ${counts.r} rolls selected, ${counts.c} closes (DRY RUN)`);

  const text = lines.join("\n");
  const chunks = text.length <= 4000 ? [{ text, parseMode: "HTML" as const }] : chunkPreRenderedTelegramHtml(text);

  for (const chunk of chunks) {
    const payload: Record<string, unknown> = {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: chunk.text,
    };
    if (chunk.parseMode) payload.parse_mode = chunk.parseMode;

    const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);

    if (resp && !resp.ok && chunk.parseMode === "HTML") {
      // PR A2 plaintext fallback pattern.
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: stripHtmlToPlain(chunk.text) }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
    }
  }
}
