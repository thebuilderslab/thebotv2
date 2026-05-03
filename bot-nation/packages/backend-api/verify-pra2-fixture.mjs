// PR A2 fixture verification — confirms the chunker does not double-escape.
// Run BEFORE deploy: `node verify-pra2-fixture.mjs`. Exits 1 on any failure.
//
// Imports the helpers directly from telegram-format.ts so we test the live
// code, not a copy. Uses tsx loader so .ts is consumable from .mjs.

// telegram-format.ts is pre-compiled to verify-out/telegram-format.js by:
//   pnpm exec tsc --module esnext --target es2022 --moduleResolution bundler \
//     --outDir verify-out --ignoreConfig src/utils/telegram-format.ts
const { escapeAgentHtml, chunkPreRenderedTelegramHtml } = await import(
  "./verify-out/telegram-format.js"
);

let failures = 0;
const fail = (label, detail) => {
  failures++;
  console.error(`❌ ${label}`);
  if (detail) console.error(`   ${detail}`);
};
const pass = (label) => console.log(`✅ ${label}`);

// ── Build a representative pre-rendered HTML payload ─────────────────────────
// Mirrors what AgentActor produces: header + escaped user content with our
// own <b>/<code> tags interleaved.
const userBody = "S&P 500 closed up 0.4%. Watch <NVDA> & </AAPL> next week.";
const escapedUser = escapeAgentHtml(userBody);

const rendered =
  `🎯 <b>${escapeAgentHtml("ACTION: Roll the SPY 590C → 595C for $0.45 net credit")}</b>\n` +
  `──────────────────────\n` +
  `✅ <b>${escapeAgentHtml("Morning trading-analysis")}</b> · 42s\n` +
  `──────────────────────\n` +
  `<b>CRITICAL NOTE:</b> ${escapedUser}\n\n` +
  `Position summary: <code>SPY 590C</code> exit at +12%.\n` +
  `──────────────────────\n` +
  `<code>/status abc123</code>`;

// ── A1: no &lt;b&gt; or &lt;/b&gt; in any chunk (double-escape canary) ──────
{
  const chunks = chunkPreRenderedTelegramHtml(rendered);
  const offenders = chunks.filter(
    (c) => /&lt;b&gt;|&lt;\/b&gt;|&lt;code&gt;|&lt;\/code&gt;/.test(c.text),
  );
  if (offenders.length === 0) {
    pass("A1: no &lt;b&gt;/&lt;code&gt; literals in chunks");
  } else {
    fail(
      "A1: double-escaped HTML tag found in chunks",
      JSON.stringify(offenders.map((c) => c.text.slice(0, 200))),
    );
  }
}

// ── A2: user-supplied < and > remain &lt; and &gt; (single-escape preserved)
{
  const chunks = chunkPreRenderedTelegramHtml(rendered);
  const merged = chunks.map((c) => c.text).join("");
  const hasEscapedUserLt = /&lt;NVDA&gt;/.test(merged);
  const hasEscapedUserGt = /&lt;\/AAPL&gt;/.test(merged);
  const hasTripleAmp = /&amp;amp;/.test(merged);

  if (hasEscapedUserLt && hasEscapedUserGt && !hasTripleAmp) {
    pass("A2: user <, >, & survive as &lt; / &gt; / &amp; (no triple-escape)");
  } else {
    fail(
      "A2: user content escape mismatch",
      `lt=${hasEscapedUserLt} gt=${hasEscapedUserGt} tripleAmp=${hasTripleAmp}`,
    );
  }
}

// ── A3: our <b>...</b> and <code>...</code> tags remain intact ──────────────
{
  const chunks = chunkPreRenderedTelegramHtml(rendered);
  const merged = chunks.map((c) => c.text).join("");
  const hasBold = /<b>CRITICAL NOTE:<\/b>/.test(merged);
  const hasCode = /<code>SPY 590C<\/code>/.test(merged);
  const hasStatusCode = /<code>\/status abc123<\/code>/.test(merged);

  if (hasBold && hasCode && hasStatusCode) {
    pass("A3: <b>...</b> and <code>...</code> tags intact across chunks");
  } else {
    fail(
      "A3: own HTML tags damaged",
      `bold=${hasBold} code=${hasCode} statusCode=${hasStatusCode}`,
    );
  }
}

// ── A4: ≥ 2 chunks when input > 8000 UTF-16 units ───────────────────────────
{
  const long =
    rendered + "\n\n" + "Filler paragraph.\n".repeat(800); // ≈ 14k chars
  const chunks = chunkPreRenderedTelegramHtml(long);
  if (long.length > 8000 && chunks.length >= 2) {
    pass(`A4: long input (${long.length} units) split into ${chunks.length} chunks`);
  } else {
    fail(
      "A4: long input did not split into ≥ 2 chunks",
      `length=${long.length} chunks=${chunks.length}`,
    );
  }

  // bonus: every chunk under the 4000-unit cap
  const oversized = chunks.filter((c) => c.text.length > 4000);
  if (oversized.length === 0) {
    pass("A4b: no chunk exceeds 4000 UTF-16 units");
  } else {
    fail("A4b: oversized chunk found", `count=${oversized.length}`);
  }

  // bonus: parseMode is HTML on every chunk so the sender keeps HTML mode
  const wrongMode = chunks.filter((c) => c.parseMode !== "HTML");
  if (wrongMode.length === 0) {
    pass("A4c: all chunks tagged parseMode=HTML");
  } else {
    fail("A4c: chunk with non-HTML parseMode", `count=${wrongMode.length}`);
  }
}

if (failures === 0) {
  console.log("\nALL FIXTURE ASSERTIONS PASSED — safe to deploy.");
  process.exit(0);
} else {
  console.error(`\n${failures} assertion(s) failed — DO NOT deploy.`);
  process.exit(1);
}
