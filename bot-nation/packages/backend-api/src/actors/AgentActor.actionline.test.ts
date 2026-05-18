/**
 * Unit tests for A.5a — ActionLine regex / double-escape bugfix.
 *
 * Mirrors the action-line extraction + formatting logic from
 * AgentActor.editTelegramCompletion (lines 1488-1528) as pure functions
 * to prove the fix without instantiating the full DO + D1 stack.
 *
 * Original bug: markdownToHtml() converted "[URGENT]" → "🔴 <b>URGENT</b>",
 * then a second escapeHtml() on the action-line extraction surfaced literal
 * "&lt;b&gt;URGENT&lt;/b&gt;" in Telegram. Fix: skip the second escape
 * because trimmedBody is already HTML-safe.
 */

import { describe, expect, it } from "vitest";

// Mirrored from AgentActor.ts:1484-1499
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const markdownToHtml = (s: string): string =>
  s
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/^#{1,3}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/^[-•]\s+/gm, "• ")
    .replace(/\[URGENT\]/g, "🔴 <b>URGENT</b>");

function processBody(raw: string): string {
  const hasHtmlTags = /<b>/.test(raw);
  return hasHtmlTags ? markdownToHtml(raw) : markdownToHtml(escapeHtml(raw));
}

// Mirrored from AgentActor.ts:1523-1528 with A.5a fix applied
function buildActionLine(trimmedBody: string): string {
  const actionItemMatch = trimmedBody.match(/---\s*\n(ACTION[^:]*:.*?)(?:\n|$)/i)
    ?? trimmedBody.match(/(ACTION ITEM:.*?)(?:\n──|$)/is);
  return actionItemMatch
    ? `🎯 <b>${(actionItemMatch[1] ?? "").replace(/^ACTION[^:]*:\s*/i, "ACTION: ").trim()}</b>\n`
    : "";
}

describe("A.5a — [URGENT] action line renders as bold, not literal", () => {
  it("preserves <b>URGENT</b> tags from markdownToHtml in the action line", () => {
    const raw = "Some context.\n---\nACTION ITEM: [URGENT] close GOOGL puts now";
    const processed = processBody(raw);
    const line = buildActionLine(processed);

    expect(line).toContain("<b>");
    expect(line).toContain("URGENT");
    expect(line).not.toContain("&lt;b&gt;");
    expect(line).not.toContain("&lt;/b&gt;");
  });

  it("does not double-escape ampersands in action items", () => {
    const raw = "---\nACTION ITEM: review P&L report";
    const processed = processBody(raw);
    const line = buildActionLine(processed);

    // After escapeHtml(raw), & becomes &amp; — that single escape is correct.
    // The bug was double-escape: &amp; → &amp;amp;.
    expect(line).toContain("&amp;");
    expect(line).not.toContain("&amp;amp;");
  });
});

describe("A.5a — no regression for non-URGENT messages", () => {
  it("renders a plain action item without HTML tags", () => {
    const raw = "---\nACTION ITEM: review the quarterly report";
    const processed = processBody(raw);
    const line = buildActionLine(processed);

    expect(line).toBe("🎯 <b>ACTION: review the quarterly report</b>\n");
  });

  it("returns empty string when no action item present", () => {
    const raw = "Just some analysis text, no action item here.";
    const processed = processBody(raw);
    const line = buildActionLine(processed);

    expect(line).toBe("");
  });

  it("renders bold markdown inside the action line correctly", () => {
    const raw = "---\nACTION ITEM: **close** the position";
    const processed = processBody(raw);
    const line = buildActionLine(processed);

    // markdownToHtml converts **close** → <b>close</b>; fix preserves this.
    expect(line).toContain("<b>close</b>");
    expect(line).not.toContain("&lt;b&gt;close&lt;/b&gt;");
  });

  it("strips ACTION prefix and trims whitespace", () => {
    const raw = "---\nACTION ITEM:    do the thing   ";
    const processed = processBody(raw);
    const line = buildActionLine(processed);

    expect(line).toBe("🎯 <b>ACTION: do the thing</b>\n");
  });
});

describe("A.5a — body escaping is unchanged (regression guard)", () => {
  it("still escapes raw < and > in body that was not yet HTML", () => {
    const raw = "x < 5 and y > 3";
    const processed = processBody(raw);

    // Raw text gets escapeHtml first, so < becomes &lt;
    expect(processed).toContain("&lt;");
    expect(processed).toContain("&gt;");
  });

  it("does not re-escape body that already has HTML tags from JSON extraction", () => {
    const raw = "Already formatted: <b>BOLD</b>";
    const processed = processBody(raw);

    expect(processed).toContain("<b>BOLD</b>");
    expect(processed).not.toContain("&lt;b&gt;");
  });
});
