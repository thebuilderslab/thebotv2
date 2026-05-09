// R-WEEKLY-DIRECTOR.1 fixture verification.
//
// Loads each JSON fixture from src/services/trading-policy/fixtures/,
// drives the deterministic core (`evaluatePosition`, `evaluateAccount`,
// `scoreCandidate`, classifiers), and asserts:
//   - selected action matches expected
//   - chosen candidate strike + expiration match expected (when applicable)
//   - all expected rejection reason codes are present in the rejected[]
//     candidate evaluations
//   - score ordering is deterministic (run twice, identical output)
//   - evaluateAccount aggregates per-position decisions correctly
//   - classifiers (classifyTrendRegime, classifyVolatilityRegime) hit
//     each branch
//
// Pre-deploy gate. Run BEFORE any commit or deploy.

import { readFileSync, readdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "src/services/trading-policy/fixtures");

const {
  WEEKLY_OPTIONS_POLICY_V1,
  evaluatePosition,
  evaluateAccount,
  evaluateCandidate,
  scoreCandidate,
  classifyTrendRegime,
  classifyVolatilityRegime,
} = await import("./verify-out/services/trading-policy/index.js");

const { enrichPositionFromChain, positionExpiryWindows } = await import("./verify-out/services/trading/weekly-options-director.js");

let failures = 0;
const fail = (label, detail) => {
  failures++;
  console.error(`❌ ${label}`);
  if (detail) console.error(`   ${detail}`);
};
const pass = (label) => console.log(`✅ ${label}`);

// ── Load fixtures ─────────────────────────────────────────────────────────────
const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith(".json"));
const fixtures = fixtureFiles.map((f) => ({
  name: f,
  data: JSON.parse(readFileSync(join(fixturesDir, f), "utf8")),
}));

console.log(`Loaded ${fixtures.length} fixtures from ${fixturesDir}`);

// ── F1–FN: per-fixture decision check ───────────────────────────────────────
for (const fx of fixtures) {
  const { name, data } = fx;
  const decision = evaluatePosition(
    WEEKLY_OPTIONS_POLICY_V1,
    data.position,
    data.market,
    data.nextWeekCandidates,
    data.sameWeekCandidates,
  );

  const expected = data.expected;

  // selectedAction
  if (decision.selectedAction !== expected.selectedAction) {
    fail(
      `[${name}] selectedAction wrong`,
      `expected=${expected.selectedAction} got=${decision.selectedAction} primaryReason=${decision.primaryReason}`,
    );
    continue;
  }

  // primaryReason (optional in fixture)
  if (expected.primaryReason && decision.primaryReason !== expected.primaryReason) {
    fail(
      `[${name}] primaryReason wrong`,
      `expected=${expected.primaryReason} got=${decision.primaryReason}`,
    );
    continue;
  }

  // reasonsInclude (subset check)
  if (Array.isArray(expected.reasonsInclude)) {
    const missing = expected.reasonsInclude.filter((r) => !decision.reasons.includes(r));
    if (missing.length > 0) {
      fail(
        `[${name}] reasons missing expected codes`,
        `missing=[${missing.join(",")}] got=[${decision.reasons.join(",")}]`,
      );
      continue;
    }
  }

  // chosenCandidate strike + expiration
  if (expected.chosenCandidateNewStrike != null) {
    if (!decision.chosenCandidate) {
      fail(`[${name}] expected chosenCandidate but got none`);
      continue;
    }
    if (decision.chosenCandidate.newStrike !== expected.chosenCandidateNewStrike) {
      fail(
        `[${name}] chosen strike wrong`,
        `expected=${expected.chosenCandidateNewStrike} got=${decision.chosenCandidate.newStrike}`,
      );
      continue;
    }
    if (
      expected.chosenCandidateExpiration &&
      decision.chosenCandidate.newExpirationDate !== expected.chosenCandidateExpiration
    ) {
      fail(
        `[${name}] chosen expiration wrong`,
        `expected=${expected.chosenCandidateExpiration} got=${decision.chosenCandidate.newExpirationDate}`,
      );
      continue;
    }
  }

  // rejectionReasonCodesPresent: check that across all rejected candidate
  // evaluations, the listed codes show up at least once each.
  if (Array.isArray(expected.rejectionReasonCodesPresent)) {
    const allCodes = new Set();
    for (const ev of decision.rejectedCandidates) {
      for (const c of ev.rejectionReasons) allCodes.add(c);
    }
    const missing = expected.rejectionReasonCodesPresent.filter((c) => !allCodes.has(c));
    if (missing.length > 0) {
      fail(
        `[${name}] expected rejection codes missing`,
        `missing=[${missing.join(",")}] seen=[${[...allCodes].join(",")}]`,
      );
      continue;
    }
  }

  pass(`[${name}] ${expected.selectedAction} (${decision.primaryReason})`);
}

// ── F-DET: score-ordering determinism ───────────────────────────────────────
{
  const fx = fixtures.find((f) => f.name === "next-week-roll-selected.json");
  if (fx) {
    const a = evaluatePosition(
      WEEKLY_OPTIONS_POLICY_V1,
      fx.data.position,
      fx.data.market,
      fx.data.nextWeekCandidates,
      fx.data.sameWeekCandidates,
    );
    const b = evaluatePosition(
      WEEKLY_OPTIONS_POLICY_V1,
      fx.data.position,
      fx.data.market,
      fx.data.nextWeekCandidates,
      fx.data.sameWeekCandidates,
    );
    if (
      a.selectedAction === b.selectedAction &&
      a.primaryReason === b.primaryReason &&
      JSON.stringify(a.chosenCandidate) === JSON.stringify(b.chosenCandidate)
    ) {
      pass("F-DET: evaluatePosition deterministic across 2 runs");
    } else {
      fail("F-DET: non-deterministic", `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`);
    }
  }
}

// ── F-ACCT: evaluateAccount aggregates correctly ────────────────────────────
{
  // Build a small 2-position account from the stop-loss + roll-selected fixtures.
  const fxStop = fixtures.find((f) => f.name === "stop-loss-close.json").data;
  const fxRoll = fixtures.find((f) => f.name === "next-week-roll-selected.json").data;

  const acct = { accountId: "ACCT-COMBO", timestampIso: new Date().toISOString() };
  const positions = [fxStop.position, fxRoll.position];
  const marketByUnderlying = {
    [fxStop.position.symbol]: fxStop.market,
    [fxRoll.position.symbol]: fxRoll.market,
  };
  const candidatesByPosition = {
    [fxStop.position.positionId]: { nextWeek: [], sameWeek: [] },
    [fxRoll.position.positionId]: {
      nextWeek: fxRoll.nextWeekCandidates,
      sameWeek: fxRoll.sameWeekCandidates,
    },
  };

  const decision = evaluateAccount(
    WEEKLY_OPTIONS_POLICY_V1,
    acct,
    positions,
    marketByUnderlying,
    candidatesByPosition,
    "test-cycle-1",
    new Date().toISOString(),
  );

  if (
    decision.decisions.length === 2 &&
    decision.decisions[0].selectedAction === "CLOSE" &&
    decision.decisions[1].selectedAction === "ROLL_NEXT_WEEK" &&
    decision.weeklyCycleId === "test-cycle-1" &&
    decision.accountId === "ACCT-COMBO"
  ) {
    pass("F-ACCT: evaluateAccount aggregates 2 positions correctly (CLOSE + ROLL_NEXT_WEEK)");
  } else {
    fail(
      "F-ACCT: aggregation wrong",
      `actions=[${decision.decisions.map((d) => d.selectedAction).join(",")}]`,
    );
  }
}

// ── F-CLS: classifiers cover regime branches ────────────────────────────────
{
  const bullStrong = classifyTrendRegime({
    price: 100, ema50: 95, ema100: 90, ema200: 85,
    rsi14: 60, targetHigh: 110, targetLow: 80,
    hourPrice: 99, hourEma21: 98, hourMacdBias: "BULL",
  });
  const bullExt = classifyTrendRegime({
    price: 100, ema50: 95, ema100: 90, ema200: 85,
    rsi14: 80, targetHigh: 110, targetLow: 80,
    hourPrice: 99, hourEma21: 98, hourMacdBias: "BULL",
  });
  const chop = classifyTrendRegime({
    price: 100, ema50: 100, ema100: 100, ema200: 100,
    rsi14: 50, targetHigh: 110, targetLow: 80,
    hourPrice: 100, hourEma21: 100, hourMacdBias: "NEUTRAL",
  });
  const bearStrong = classifyTrendRegime({
    price: 80, ema50: 90, ema100: 95, ema200: 100,
    rsi14: 40, targetHigh: 110, targetLow: 70,
    hourPrice: 81, hourEma21: 82, hourMacdBias: "BEAR",
  });

  if (bullStrong === "BULL_STRONG" && bullExt === "BULL_EXT" && chop === "CHOP" && bearStrong === "BEAR_STRONG") {
    pass("F-CLS: trend classifier hits BULL_STRONG / BULL_EXT / CHOP / BEAR_STRONG branches");
  } else {
    fail("F-CLS: trend regime mis-classification", `bullStrong=${bullStrong} bullExt=${bullExt} chop=${chop} bearStrong=${bearStrong}`);
  }

  const volNormal = classifyVolatilityRegime(1.0, 1.0, false);
  const volHigh = classifyVolatilityRegime(2.0, 1.0, false);
  const volLow = classifyVolatilityRegime(0.6, 1.0, false);
  const volSpike = classifyVolatilityRegime(0.5, 1.0, true);

  if (volNormal === "VOL_NORMAL" && volHigh === "VOL_HIGH" && volLow === "VOL_LOW" && volSpike === "VOL_HIGH_INTRADAY") {
    pass("F-CLS: volatility classifier hits VOL_NORMAL / VOL_HIGH / VOL_LOW / VOL_HIGH_INTRADAY branches");
  } else {
    fail("F-CLS: volatility regime mis-classification", `n=${volNormal} h=${volHigh} l=${volLow} s=${volSpike}`);
  }
}

// ── F-SCORE: scoring formula sanity ──────────────────────────────────────────
{
  const market = {
    symbol: "X", asOfIso: "2026-05-08T00:00:00Z",
    trendRegime: "BULL_STRONG", volatilityRegime: "VOL_NORMAL",
    todayOpen: 100, atr14: 1, atr20Avg: 1,
    targetHigh: 110, targetLow: 90, priorHigh: 101, priorLow: 99, priorClose: 100,
    hasEarningsTodayOrTomorrow: false, hasMajorMacroEvent: false,
  };
  const better = {
    estimatedProfitImprovementPct: 0.50, deltaReductionPctFromCurrent: 0.40, spread: 0.05,
  };
  const worse = {
    estimatedProfitImprovementPct: 0.20, deltaReductionPctFromCurrent: 0.10, spread: 0.20,
  };
  const sBetter = scoreCandidate(better, market);
  const sWorse = scoreCandidate(worse, market);
  if (sBetter > sWorse) {
    pass(`F-SCORE: better candidate scores higher (${sBetter.toFixed(2)} > ${sWorse.toFixed(2)})`);
  } else {
    fail("F-SCORE: better candidate did not outscore worse", `better=${sBetter} worse=${sWorse}`);
  }
}

// ── F-CAND: evaluateCandidate produces correct rejection set ────────────────
{
  const fxNetDebit = fixtures.find((f) => f.name === "net-debit-reject.json").data;
  const ev = evaluateCandidate(
    WEEKLY_OPTIONS_POLICY_V1,
    fxNetDebit.position,
    fxNetDebit.market,
    fxNetDebit.nextWeekCandidates[0],
    "NEXT_WEEK",
    false,
  );
  if (!ev.eligible && ev.rejectionReasons.includes("NET_DEBIT_REJECTED")) {
    pass("F-CAND: net-debit candidate rejected with NET_DEBIT_REJECTED");
  } else {
    fail("F-CAND: net-debit candidate eligibility wrong", `eligible=${ev.eligible} reasons=[${ev.rejectionReasons.join(",")}]`);
  }
}

// ── F-ENRICH: enrichPositionFromChain (R-WEEKLY-DIRECTOR.1.2) ───────────────
// Pre-1.2: position.delta=null and position.underlyingPrice=0 from the
// orchestrator (schwab_positions table doesn't store deltas/quotes).
// Post-1.2: orchestrator pulls both from the per-position chain fetch.
{
  const basePosition = {
    accountId: "5105",
    symbol: "GOOGL",
    positionId: "pos-test-1",
    optionType: "CALL",
    side: "LONG",
    quantity: 1,
    strike: 430,
    expirationDate: "2026-06-18",
    mark: 5.55,
    delta: null,           // pre-enrichment state
    pnlPct: 1.91,
    daysToExpiry: 40,
    underlyingPrice: 0,    // pre-enrichment state
    strategyTag: null,
  };
  const chainRows = [
    { contractType: "CALL", strike: 425, expirationDate: "2026-06-18", delta: 0.58 },
    { contractType: "CALL", strike: 430, expirationDate: "2026-06-18", delta: 0.52 }, // matches position
    { contractType: "CALL", strike: 435, expirationDate: "2026-06-18", delta: 0.46 },
    { contractType: "PUT",  strike: 430, expirationDate: "2026-06-18", delta: -0.48 }, // wrong contractType
    { contractType: "CALL", strike: 430, expirationDate: "2026-05-22", delta: 0.20 }, // wrong expiry
  ];
  const enriched = enrichPositionFromChain(basePosition, chainRows, 396.63);

  if (enriched.delta === 0.52 && enriched.underlyingPrice === 396.63) {
    pass(`F-ENRICH: matching CALL @ 430 / 2026-06-18 → delta=0.52, underlyingPrice=$396.63`);
  } else {
    fail(`F-ENRICH: enrichment wrong`, `delta=${enriched.delta} underlyingPrice=${enriched.underlyingPrice}`);
  }

  // Defensive: position.delta + underlyingPrice unchanged when no match
  const noMatch = enrichPositionFromChain(
    { ...basePosition, strike: 999 },                  // strike won't match any row
    chainRows,
    null,                                              // no live quote
  );
  if (noMatch.delta === null && noMatch.underlyingPrice === 0) {
    pass(`F-ENRICH: no matching row + no underlying quote → original (null/0) preserved`);
  } else {
    fail(`F-ENRICH: defensive defaults wrong`, `delta=${noMatch.delta} underlyingPrice=${noMatch.underlyingPrice}`);
  }

  // Defensive: matching row with null delta doesn't overwrite valid existing value
  const incomingNull = enrichPositionFromChain(
    { ...basePosition, delta: 0.52 },                  // already has a delta
    [{ contractType: "CALL", strike: 430, expirationDate: "2026-06-18", delta: null }],
    396.63,
  );
  if (incomingNull.delta === 0.52) {
    pass(`F-ENRICH: matching row with null delta does NOT overwrite existing position.delta`);
  } else {
    fail(`F-ENRICH: null overwrite wrong`, `delta=${incomingNull.delta}`);
  }

  // Defensive: zero/negative underlying price doesn't get used (Number.isFinite + > 0 guard)
  const zeroQuote = enrichPositionFromChain(basePosition, chainRows, 0);
  if (zeroQuote.underlyingPrice === 0) {
    pass(`F-ENRICH: underlyingPrice=0 from quote ignored (sentinel value, not real)`);
  } else {
    fail(`F-ENRICH: zero quote should be ignored`, `underlyingPrice=${zeroQuote.underlyingPrice}`);
  }
}

// ── F-WIN-1..4: positionExpiryWindows (R-WEEKLY-DIRECTOR.1.3) ───────────────
// Pre-1.3: windows were today-relative (upcomingFriday/nextFriday). Live dry
// run #3 selected GOOGL 410C 2026-05-15 for a position expiring 2026-06-18 —
// 5 weeks BACKWARD. Post-1.3: windows are anchored on each position's own
// expiry date.

// F-WIN-1: position expires Thursday Jun 18 2026 → Friday-of-week is Jun 19,
//          forward weeks +7/+14/+21 = Jun 26 / Jul 3 / Jul 10
{
  const win = positionExpiryWindows("2026-06-18"); // Thursday
  if (
    win.positionWeekFriday === "2026-06-19" &&
    win.sameWeekDates.length === 2 &&
    win.sameWeekDates.includes("2026-06-18") &&
    win.sameWeekDates.includes("2026-06-19") &&
    win.nextWeek1 === "2026-06-26" &&
    win.nextWeek2 === "2026-07-03" &&
    win.nextWeek3 === "2026-07-10" &&
    win.fromDate === "2026-06-18" &&
    win.toDate === "2026-07-10"
  ) {
    pass(`F-WIN-1: Thursday Jun 18 → friday=Jun 19, sameWeek=[Jun 18, Jun 19], next=[Jun 26, Jul 3, Jul 10]`);
  } else {
    fail(`F-WIN-1: Thursday-expiry windows wrong`, JSON.stringify(win));
  }
}

// F-WIN-2: position expires Friday Jun 19 2026 → sameWeekDates dedupes to
//          single date, forward weeks identical to F-WIN-1
{
  const win = positionExpiryWindows("2026-06-19"); // Friday
  if (
    win.positionWeekFriday === "2026-06-19" &&
    win.sameWeekDates.length === 1 &&
    win.sameWeekDates[0] === "2026-06-19" &&
    win.nextWeek1 === "2026-06-26"
  ) {
    pass(`F-WIN-2: Friday Jun 19 → sameWeekDates deduped to [Jun 19]`);
  } else {
    fail(`F-WIN-2: Friday-expiry windows wrong`, JSON.stringify(win));
  }
}

// F-WIN-3: today-relative wrong-week sentinel — chain row for 2026-05-15
//          (the wrong-week date that bit dry run #3) MUST NOT match either
//          window for a position expiring 2026-06-18.
{
  const win = positionExpiryWindows("2026-06-18");
  const wrongWeekRow = { contractType: "CALL", strike: 410, expirationDate: "2026-05-15", delta: 0.20 };
  const inSameWeek = win.sameWeekDates.includes(wrongWeekRow.expirationDate);
  const inNextWeek =
    wrongWeekRow.expirationDate === win.nextWeek1 ||
    wrongWeekRow.expirationDate === win.nextWeek2 ||
    wrongWeekRow.expirationDate === win.nextWeek3;
  if (!inSameWeek && !inNextWeek) {
    pass(`F-WIN-3: today-relative wrong-week chain (May 15) NOT selected for Jun 18 position — backward bug fixed`);
  } else {
    fail(`F-WIN-3: wrong-week row leaked`, `inSameWeek=${inSameWeek} inNextWeek=${inNextWeek}`);
  }
}

// F-WIN-4: position expires Jun 18; chain has rows for Jun 18, Jun 19, Jun 26
//          → sameWeekRows captures Jun 18 + Jun 19, nextWeekRows captures Jun 26.
//          Verifies the orchestrator's filter logic against the helper output.
{
  const win = positionExpiryWindows("2026-06-18");
  const rows = [
    { contractType: "CALL", strike: 430, expirationDate: "2026-06-18", delta: 0.27 }, // position's own expiry (Thu)
    { contractType: "CALL", strike: 430, expirationDate: "2026-06-19", delta: 0.28 }, // same-week Friday
    { contractType: "CALL", strike: 430, expirationDate: "2026-06-26", delta: 0.29 }, // next-week Friday
    { contractType: "CALL", strike: 430, expirationDate: "2026-05-15", delta: 0.18 }, // wrong-week sentinel (must not appear)
  ];
  const sameWeek = rows.filter((r) => win.sameWeekDates.includes(r.expirationDate));
  const nextWeek = rows.filter(
    (r) => r.expirationDate === win.nextWeek1
        || r.expirationDate === win.nextWeek2
        || r.expirationDate === win.nextWeek3,
  );
  const sameOk = sameWeek.length === 2 &&
    sameWeek.some((r) => r.expirationDate === "2026-06-18") &&
    sameWeek.some((r) => r.expirationDate === "2026-06-19");
  const nextOk = nextWeek.length === 1 && nextWeek[0].expirationDate === "2026-06-26";
  const wrongLeaked = sameWeek.concat(nextWeek).some((r) => r.expirationDate === "2026-05-15");
  if (sameOk && nextOk && !wrongLeaked) {
    pass(`F-WIN-4: filter on real chain → sameWeek=[Jun 18, Jun 19], nextWeek=[Jun 26], wrong-week May 15 excluded`);
  } else {
    fail(`F-WIN-4: chain filter wrong`, `sameOk=${sameOk} nextOk=${nextOk} wrongLeaked=${wrongLeaked} sameWeek=${JSON.stringify(sameWeek)} nextWeek=${JSON.stringify(nextWeek)}`);
  }
}

if (failures === 0) {
  console.log("\nALL FIXTURE ASSERTIONS PASSED — safe to deploy.");
  process.exit(0);
} else {
  console.error(`\n${failures} assertion(s) failed — DO NOT deploy.`);
  process.exit(1);
}
