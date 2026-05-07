// A.5a-followup fixture — confirms the actionLine over-capture and
// empty-body bugs from 2026-05-07 don't recur.
//
// Pre-fix bug 1 (literal <b>...</b> leak):
//   trimmedBody = "ACTION ITEM: Conduct weather query.\n\n<b>Key Concepts:</b> ..."
//   broken regex: /(ACTION ITEM:.*?)(?:\n──|$)/is
//     - `s` flag: . matches \n
//     - `\n──` lookahead never matches (dividers added later)
//     - non-greedy .*? extends to EOF
//     - capture includes <b>Key Concepts:</b> tags
//     - escapeAgentHtml escapes them → Telegram displays literal "<b>Key Concepts:</b>"
//   fixed regex: /(ACTION ITEM:.*?)(?:\n|$)/i
//     - no `s` flag, terminates at first \n
//     - capture is single-line, no embedded HTML
//
// Pre-fix bug 2 (empty body between dividers):
//   midday brief task f717f77c had {"summary":"","artifactIds":[...]} with
//   artifact content `{"response":""}` — agent produced no text.
//   Pre-fix render: "<dividers>\n\n<dividers>\n<code>/status ...</code>"
//   Operator saw blank message — no diagnostic affordance.
//   Fix: when cleanBody is empty, render a fallback notice with /status hint.

const {
  extractActionLine,
  stripActionAndTradeOrderBlocks,
  renderBodyWithFallback,
} = await import("./verify-out/actors/AgentActor.js");

let failures = 0;
const fail = (label, detail) => {
  failures++;
  console.error(`❌ ${label}`);
  if (detail) console.error(`   ${detail}`);
};
const pass = (label) => console.log(`✅ ${label}`);

// ── F1: weather brief case — ACTION ITEM + post-action body with markdown ────
{
  // Mirrors what trimmedBody looks like AFTER markdownToHtml has converted
  // `**Key Concepts:**` → `<b>Key Concepts:</b>` (i.e., what production sees
  // when the actionLine extraction runs).
  const trimmedBody = "ACTION ITEM: Conduct a real-time weather data query for the current day.\n\n<b>[Weather Today]</b> — [Requires Location Data for Specificity]\n\n<b>Key Concepts:</b>\n* <b>Location Specificity:</b> Weather is highly localized.";
  const actionLine = extractActionLine(trimmedBody);
  const hasLeakedHtml = /&lt;\/?b/i.test(actionLine);
  const hasActionContent = /ACTION:.*weather/i.test(actionLine);
  if (!hasLeakedHtml && hasActionContent) {
    pass(`F1: weather case → action header is single-line, no leaked &lt;b&gt;`);
  } else {
    fail(
      `F1: actionLine leaked HTML or missed ACTION content`,
      `actionLine=${JSON.stringify(actionLine.slice(0, 200))}`,
    );
  }
}

// ── F2: cleanBody on weather case — body content survives, ACTION line stripped
{
  const trimmedBody = "ACTION ITEM: Conduct a real-time weather data query for the current day.\n\n<b>[Weather Today]</b> — [Requires Location Data for Specificity]\n\n<b>Key Concepts:</b>\n* <b>Location Specificity:</b> Weather is highly localized.";
  const cleanBody = stripActionAndTradeOrderBlocks(trimmedBody);
  const stripped = !/ACTION ITEM:/i.test(cleanBody);
  const bodyKept = /Weather Today/i.test(cleanBody) && /Key Concepts/i.test(cleanBody);
  if (stripped && bodyKept) {
    pass(`F2: weather case → ACTION line stripped, body content (Weather/Key Concepts) preserved`);
  } else {
    fail(
      `F2: cleanBody mis-stripped`,
      `stripped=${stripped} bodyKept=${bodyKept} body=${JSON.stringify(cleanBody.slice(0, 200))}`,
    );
  }
}

// ── F3: pre-fix would have collapsed cleanBody to empty — confirm it doesn't
// Pre-fix: regex `/---\s*\nACTION[^:]*:.*?(?=\n──|$)/is` with `---\n` prefix
// and `s` flag would capture from `---\n` to EOF, stripping everything.
{
  const trimmedBody = "---\nACTION ITEM: Hold positions.\n\n<b>POSITIONS</b>\nGOOGL, TSLA, SPY all green.";
  const cleanBody = stripActionAndTradeOrderBlocks(trimmedBody);
  const positionsKept = /POSITIONS/i.test(cleanBody) && /GOOGL/i.test(cleanBody);
  if (positionsKept) {
    pass(`F3: cleanBody preserves post-ACTION body (was wiped to empty pre-fix)`);
  } else {
    fail(
      `F3: cleanBody over-stripped past ACTION line`,
      `body=${JSON.stringify(cleanBody.slice(0, 200))}`,
    );
  }
}

// ── F4: ACTION line followed immediately by body without blank line ──────────
{
  const trimmedBody = "ACTION ITEM: Roll the SPY 590C → 595C for $0.45 credit.\n<b>POSITIONS</b>\nGOOGL +5%";
  const actionLine = extractActionLine(trimmedBody);
  const cleanBody  = stripActionAndTradeOrderBlocks(trimmedBody);
  if (
    !/&lt;b/i.test(actionLine) &&
    /ACTION:.*Roll the SPY/i.test(actionLine) &&
    /POSITIONS/i.test(cleanBody) &&
    !/ACTION ITEM:/i.test(cleanBody)
  ) {
    pass(`F4: ACTION line + tight body → header isolated, body intact, ACTION stripped`);
  } else {
    fail(
      `F4: tight body case failed`,
      `actionLine=${JSON.stringify(actionLine.slice(0, 200))} cleanBody=${JSON.stringify(cleanBody.slice(0, 200))}`,
    );
  }
}

// ── F5: empty body → renderBodyWithFallback produces non-empty user content ──
{
  const fallback = renderBodyWithFallback("", "f717f77c-8c5b-458e-baf6-b7740e37f432");
  const isNonEmpty = fallback.length > 20;
  const containsTaskId = fallback.includes("f717f77c-8c5b-458e-baf6-b7740e37f432");
  const containsStatusHint = /\/status/.test(fallback);
  if (isNonEmpty && containsTaskId && containsStatusHint) {
    pass(`F5: empty body → fallback notice with /status <taskId> diagnostic hint`);
  } else {
    fail(
      `F5: fallback should be non-empty, contain taskId + /status`,
      `fallback=${JSON.stringify(fallback.slice(0, 200))}`,
    );
  }
}

// ── F6: non-empty body → renderBodyWithFallback returns it unchanged ─────────
{
  const body = "Real position content here.\nGOOGL +$605";
  const out = renderBodyWithFallback(body, "any-id");
  if (out === body) {
    pass(`F6: non-empty body → returned unchanged (no fallback applied)`);
  } else {
    fail(`F6: should return body unchanged`, `out=${JSON.stringify(out.slice(0, 200))}`);
  }
}

// ── F7: ACTION-only body that strips to empty → still get fallback ───────────
// "ACTION ITEM: x" alone → stripped to "" → fallback fires.
{
  const trimmedBody = "ACTION ITEM: Stand by, no positions.";
  const cleanBody = stripActionAndTradeOrderBlocks(trimmedBody);
  const rendered  = renderBodyWithFallback(cleanBody, "task-123");
  const isFallback = /agent produced no content/i.test(rendered);
  if (cleanBody.length === 0 && isFallback) {
    pass(`F7: ACTION-only body → strip empties → fallback notice fires`);
  } else {
    fail(
      `F7: ACTION-only case`,
      `cleanBody=${JSON.stringify(cleanBody)} rendered=${JSON.stringify(rendered.slice(0, 200))}`,
    );
  }
}

// ── F8: TRADE_ORDER block stripped without affecting surrounding body ────────
{
  const trimmedBody = "Position summary: SPY 590C.\n##TRADE_ORDER##\n{\"price\": 0.45}\n##END_TRADE_ORDER##\nNext steps: monitor.";
  const cleanBody = stripActionAndTradeOrderBlocks(trimmedBody);
  const tradeStripped = !/TRADE_ORDER/i.test(cleanBody);
  const surroundingKept = /Position summary/i.test(cleanBody) && /Next steps/i.test(cleanBody);
  if (tradeStripped && surroundingKept) {
    pass(`F8: TRADE_ORDER block stripped, surrounding body preserved`);
  } else {
    fail(
      `F8: TRADE_ORDER strip case`,
      `body=${JSON.stringify(cleanBody.slice(0, 200))}`,
    );
  }
}

// ── F9: pre-fix sentinel — broken pattern would have included <b>...</b> in actionLine
{
  const trimmedBody = "ACTION ITEM: x\n<b>leaked</b>\nmore body";
  const actionLine = extractActionLine(trimmedBody);
  if (!actionLine.includes("&lt;b&gt;leaked&lt;/b&gt;") && !actionLine.includes("<b>leaked</b>")) {
    pass(`F9: regression sentinel — no &lt;b&gt; / <b> leaked into actionLine`);
  } else {
    fail(
      `F9: HTML still leaking into actionLine`,
      `actionLine=${JSON.stringify(actionLine.slice(0, 300))}`,
    );
  }
}

// ── F10: --- prefix variant of action line — capture group works ─────────────
{
  const trimmedBody = "## POSITIONS\nXYZ\n---\nACTION ITEM: Sell when price hits $100.\nBody continues.";
  const actionLine = extractActionLine(trimmedBody);
  if (/ACTION:.*Sell when price hits/i.test(actionLine)) {
    pass(`F10: --- prefix ACTION line → captured correctly`);
  } else {
    fail(
      `F10: --- prefix case`,
      `actionLine=${JSON.stringify(actionLine.slice(0, 200))}`,
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
