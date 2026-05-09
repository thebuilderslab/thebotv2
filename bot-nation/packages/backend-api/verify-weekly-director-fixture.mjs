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

if (failures === 0) {
  console.log("\nALL FIXTURE ASSERTIONS PASSED — safe to deploy.");
  process.exit(0);
} else {
  console.error(`\n${failures} assertion(s) failed — DO NOT deploy.`);
  process.exit(1);
}
