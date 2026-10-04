/**
 * Unit tests for markdownToTelegramHtml + formatMarkdownForTelegram —
 * the "View breakdown" button's rendering path.
 */

import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml, formatMarkdownForTelegram } from "./telegram-format";

describe("markdownToTelegramHtml", () => {
  it("converts **bold** to <b>", () => {
    expect(markdownToTelegramHtml("this is **bold** text")).toBe("this is <b>bold</b> text");
  });

  it("converts ## headers to <b>", () => {
    expect(markdownToTelegramHtml("## POSITION CHECK")).toBe("<b>POSITION CHECK</b>");
  });

  it("converts bullets to •", () => {
    expect(markdownToTelegramHtml("- Stop loss\n- Profit target"))
      .toBe("• Stop loss\n• Profit target");
  });

  it("converts `inline code` to <code>", () => {
    expect(markdownToTelegramHtml("run `wrangler deploy`")).toBe("run <code>wrangler deploy</code>");
  });

  it("escapes raw HTML glyphs before converting (no parser break)", () => {
    // A raw "<" in the body must be escaped so Telegram doesn't misread it.
    expect(markdownToTelegramHtml("P&L < 5% is **bad**"))
      .toBe("P&amp;L &lt; 5% is <b>bad</b>");
  });

  it("leaves markdown tables as readable pipe text (not broken)", () => {
    const table = "| Symbol | Type |\n|--------|------|\n| DRAM | PUT |";
    const out = markdownToTelegramHtml(table);
    expect(out).toContain("| Symbol | Type |");
    expect(out).not.toContain("&lt;"); // no stray escaped tags
  });
});

describe("formatMarkdownForTelegram", () => {
  it("returns a single HTML chunk for short input with a header", () => {
    const chunks = formatMarkdownForTelegram("**Pre-Close** check\n## Positions", "📋 <b>Full breakdown</b>");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.parseMode).toBe("HTML");
    expect(chunks[0]?.text).toContain("📋 <b>Full breakdown</b>");
    expect(chunks[0]?.text).toContain("<b>Pre-Close</b>");
    expect(chunks[0]?.text).toContain("<b>Positions</b>");
  });

  it("splits long input into multiple chunks", () => {
    const long = ("word ".repeat(2000)).trim(); // ~10k chars
    const chunks = formatMarkdownForTelegram(long);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(4000);
  });
});
