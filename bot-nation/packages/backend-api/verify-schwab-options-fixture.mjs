// Schwab options cost_basis fixture — confirms the 100x contract multiplier
// is applied on options and NOT on equities.
//
// Pre-fix bug (visible in production 2026-05-07):
//   TSLA 260515C00480000, qty=1, avg=$0.52, marketValue=$28
//   broken: costBasis = 1 × $0.52 = $0.52    (wrong; missing 100x)
//           unrealizedPnl = $28 - $0.52 = +$27.48 (POSITIVE — agent reports gain)
//   actual: TOS shows P/L Open ($24.66) — i.e. NEGATIVE -$24.66 loss
//
// Post-fix:
//   costBasis = 1 × $0.52 × 100 = $52
//   unrealizedPnl = $28 - $52 = -$24 (matches TOS within rounding)
//
// Run BEFORE deploy: `node verify-schwab-options-fixture.mjs`. Exits 1 on any failure.

const { computePositionFinancials } = await import(
  "./verify-out/services/schwab-positions.js"
);

let failures = 0;
const fail = (label, detail) => {
  failures++;
  console.error(`❌ ${label}`);
  if (detail) console.error(`   ${detail}`);
};
const pass = (label) => console.log(`✅ ${label}`);

// Tolerance for rounding (Schwab marks are penny-precise; we accept 1¢ drift).
const eq = (a, b) => Math.abs(a - b) < 0.01;

// ── F1: TSLA 260515C00480000 — the canonical bug case ────────────────────────
{
  const raw = {
    longQuantity: 1,
    shortQuantity: 0,
    averagePrice: 0.52,
    marketValue: 28.00,
    instrument: { assetType: "OPTION", symbol: "TSLA  260515C00480000" },
  };
  const { quantity, costBasis, unrealizedPnl } = computePositionFinancials(raw);
  if (quantity === 1 && eq(costBasis, 52) && eq(unrealizedPnl, -24)) {
    pass(`F1: TSLA 480C qty=1 avg=$0.52 mark=$0.27/contract → costBasis=$52, P&L=-$24 (loss correctly signed)`);
  } else {
    fail(
      `F1: TSLA option costBasis/P&L wrong`,
      `qty=${quantity} costBasis=${costBasis} unrealizedPnl=${unrealizedPnl}`,
    );
  }
}

// ── F2: GOOGL 260618C00430000 — large winner, sign + magnitude check ─────────
{
  const raw = {
    longQuantity: 1,
    shortQuantity: 0,
    averagePrice: 1.91,
    marketValue: 607.50,
    instrument: { assetType: "OPTION", symbol: "GOOGL 260618C00430000" },
  };
  const { quantity, costBasis, unrealizedPnl } = computePositionFinancials(raw);
  // costBasis = 1 × 1.91 × 100 = $191
  // unrealizedPnl = $607.50 - $191 = +$416.50 (NOT $605.59 from the broken pre-fix path)
  if (quantity === 1 && eq(costBasis, 191) && eq(unrealizedPnl, 416.50)) {
    pass(`F2: GOOGL 430C qty=1 avg=$1.91 → costBasis=$191, P&L=+$416.50 (NOT the broken +$605.59)`);
  } else {
    fail(
      `F2: GOOGL option costBasis/P&L wrong`,
      `qty=${quantity} costBasis=${costBasis} unrealizedPnl=${unrealizedPnl}`,
    );
  }
}

// ── F3: SPY 260717C00815000 — third position from today's chat ───────────────
{
  const raw = {
    longQuantity: 1,
    shortQuantity: 0,
    averagePrice: 0.26,
    marketValue: 46.50,
    instrument: { assetType: "OPTION", symbol: "SPY   260717C00815000" },
  };
  const { quantity, costBasis, unrealizedPnl } = computePositionFinancials(raw);
  // costBasis = 1 × 0.26 × 100 = $26
  // unrealizedPnl = $46.50 - $26 = +$20.50 (NOT the broken +$46.24)
  if (quantity === 1 && eq(costBasis, 26) && eq(unrealizedPnl, 20.50)) {
    pass(`F3: SPY 815C qty=1 avg=$0.26 → costBasis=$26, P&L=+$20.50 (NOT the broken +$46.24)`);
  } else {
    fail(
      `F3: SPY option costBasis/P&L wrong`,
      `qty=${quantity} costBasis=${costBasis} unrealizedPnl=${unrealizedPnl}`,
    );
  }
}

// ── F4: equity position MUST NOT apply the 100x multiplier ───────────────────
{
  const raw = {
    longQuantity: 10,
    shortQuantity: 0,
    averagePrice: 150.00,
    marketValue: 1600.00,
    instrument: { assetType: "EQUITY", symbol: "AAPL" },
  };
  const { quantity, costBasis, unrealizedPnl } = computePositionFinancials(raw);
  // For equities marketValue = shares × markPrice, averagePrice = per share.
  // costBasis should be 10 × $150 = $1500 (NOT $150,000 if multiplier wrongly applied).
  if (quantity === 10 && eq(costBasis, 1500) && eq(unrealizedPnl, 100)) {
    pass(`F4: AAPL equity qty=10 avg=$150 → costBasis=$1500, P&L=+$100 (no 100x applied)`);
  } else {
    fail(
      `F4: AAPL equity wrongly multiplied (would over-apply 100x)`,
      `qty=${quantity} costBasis=${costBasis} unrealizedPnl=${unrealizedPnl}`,
    );
  }
}

// ── F5: short option (negative quantity) — sign discipline check ─────────────
{
  // Hypothetical short call: longQuantity=0, shortQuantity=2, avg=$1.50, marketValue=-$200
  // (Schwab returns negative marketValue for short positions.)
  const raw = {
    longQuantity: 0,
    shortQuantity: 2,
    averagePrice: 1.50,
    marketValue: -200.00,
    instrument: { assetType: "OPTION", symbol: "SPY   260919C00500000" },
  };
  const { quantity, costBasis, unrealizedPnl } = computePositionFinancials(raw);
  // quantity = 0 - 2 = -2
  // costBasis = -2 × $1.50 × 100 = -$300
  // unrealizedPnl = -$200 - (-$300) = +$100 (short collected $300 premium, now buy back at $200 → +$100 profit)
  if (quantity === -2 && eq(costBasis, -300) && eq(unrealizedPnl, 100)) {
    pass(`F5: short option qty=-2 avg=$1.50 → costBasis=-$300, P&L=+$100 (signed correctly)`);
  } else {
    fail(
      `F5: short option signed math wrong`,
      `qty=${quantity} costBasis=${costBasis} unrealizedPnl=${unrealizedPnl}`,
    );
  }
}

// ── F6: missing fields (defensive nullishness) ───────────────────────────────
{
  const raw = { instrument: { assetType: "OPTION" } };
  const { quantity, costBasis, unrealizedPnl } = computePositionFinancials(raw);
  if (quantity === 0 && costBasis === 0 && unrealizedPnl === 0) {
    pass(`F6: missing fields → all zeros (no NaN, no throw)`);
  } else {
    fail(
      `F6: missing fields should produce zeros`,
      `qty=${quantity} costBasis=${costBasis} unrealizedPnl=${unrealizedPnl}`,
    );
  }
}

// ── F7: pre-fix regression sentinel ──────────────────────────────────────────
// Asserts the EXACT broken numbers from the May 7 production chat are NOT
// produced anymore. If any of these match, the fix has been undone.
{
  const tsla = computePositionFinancials({
    longQuantity: 1, shortQuantity: 0, averagePrice: 0.52, marketValue: 28.00,
    instrument: { assetType: "OPTION", symbol: "TSLA" },
  });
  const googl = computePositionFinancials({
    longQuantity: 1, shortQuantity: 0, averagePrice: 1.91, marketValue: 607.50,
    instrument: { assetType: "OPTION", symbol: "GOOGL" },
  });
  const spy = computePositionFinancials({
    longQuantity: 1, shortQuantity: 0, averagePrice: 0.26, marketValue: 46.50,
    instrument: { assetType: "OPTION", symbol: "SPY" },
  });
  const brokenTsla  = eq(tsla.unrealizedPnl, 27.48);   // pre-fix value
  const brokenGoogl = eq(googl.unrealizedPnl, 605.59); // pre-fix value
  const brokenSpy   = eq(spy.unrealizedPnl, 46.24);    // pre-fix value
  if (!brokenTsla && !brokenGoogl && !brokenSpy) {
    pass(`F7: pre-fix wrong values (+$27.48 / +$605.59 / +$46.24) NO LONGER produced`);
  } else {
    fail(
      `F7: pre-fix values still produced — fix has regressed`,
      `tsla=${tsla.unrealizedPnl} googl=${googl.unrealizedPnl} spy=${spy.unrealizedPnl}`,
    );
  }
}

if (failures === 0) {
  console.log("\nALL FIXTURE ASSERTIONS PASSED — safe to deploy.");
  process.exit(0);
} else {
  console.error(`\n${failures} assertion(s) failed — DO NOT deploy.`);
  process.exit(1);
}
