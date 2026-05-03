/**
 * Telegram message formatter — R16 (Phase A.5).
 *
 * Single normalization pipeline for outbound agent output. Closes the silent
 * 04-30 trading-brief drop where unescaped `<`/`>` glyphs in the body caused
 * Telegram's HTML parser to return 400 and the catch-block swallowed the error.
 *
 * Telegram counts UTF-16 code units (JavaScript .length), NOT UTF-8 bytes.
 * Max message size is 4096 units; we chunk at 4000 for headroom.
 */

export interface TelegramChunk {
  text: string;
  parseMode: "HTML" | null;
  index?: number;
  total?: number;
}

const MAX_CHUNK_LENGTH = 4000;

/**
 * Chunk an already-rendered Telegram HTML string. Used by the long-message
 * path in AgentActor where the body has been built once with our own
 * <b>/<code>/<i> tags + escaped user text. Re-running formatForTelegram here
 * was double-escaping (`<b>` → `&lt;b&gt;` visible in chat). This helper
 * does NO additional escaping and NO action-block stripping — caller owns
 * that. It just chunks at UTF-16 boundaries (preferring newline breaks)
 * and tags each chunk with parseMode HTML so the sender keeps that mode.
 */
export function chunkPreRenderedTelegramHtml(html: string): TelegramChunk[] {
  const chunks = chunkByUtf16Length(html, MAX_CHUNK_LENGTH);
  return chunks.map((text, i) => ({
    text,
    parseMode: "HTML" as const,
    index: i,
    total: chunks.length,
  }));
}

/** Strip the existing ACTION-block + TRADE_ORDER markers (mirrors AgentActor.ts:1295). */
function stripActionBlocks(raw: string): string {
  return raw
    .replace(/---\s*\nACTION[^:]*:.*?(?=\n──|$)/gis, "")
    .replace(/ACTION ITEM:.*?(?=\n|$)/gi, "")
    .replace(/##TRADE_ORDER##[\s\S]*?##END_TRADE_ORDER##/g, "")
    .trim();
}

/** Escape `<`, `>`, `&` so Telegram's HTML parser doesn't choke on agent output. */
export function escapeAgentHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Strip all HTML tags + decode the entities we add. Used for plain-text fallback. */
export function stripHtmlToPlain(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ");
}

/**
 * Chunk by UTF-16 code units (JavaScript string .length). If we're not at the
 * end of input, prefer breaking at the last newline within the chunk window
 * (above the 80% mark) so chunks don't slice mid-paragraph.
 */
export function chunkByUtf16Length(text: string, maxLength: number = MAX_CHUNK_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + maxLength, text.length);

    if (end < text.length) {
      const lastNewline = text.lastIndexOf("\n", end);
      if (lastNewline > start + maxLength * 0.8) {
        end = lastNewline + 1;
      }
    }

    chunks.push(text.slice(start, end));
    start = end;
  }

  return chunks;
}

/**
 * Validate that a chunk's tags balance for Telegram's HTML mode.
 * Telegram supports: <b>, <strong>, <i>, <em>, <u>, <ins>, <s>, <strike>,
 * <del>, <code>, <pre>, <a>, <tg-spoiler>. Returns false on any unbalanced
 * tag — caller falls back to plain text.
 */
export function validateTelegramHtml(chunk: string): boolean {
  const tagStack: string[] = [];
  const tagRegex = /<\/?([a-z-]+)[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(chunk)) !== null) {
    const fullTag = match[0];
    const tagName = (match[1] ?? "").toLowerCase();

    if (fullTag.startsWith("</")) {
      const expected = tagStack.pop();
      if (expected !== tagName) return false;
    } else if (!fullTag.endsWith("/>")) {
      tagStack.push(tagName);
    }
  }

  return tagStack.length === 0;
}

/**
 * Format agent output for Telegram delivery.
 *
 * 1. Strip action-blocks + trade-order markers (already surfaced separately)
 * 2. Escape `<`/`>`/`&` in the agent body (the line 1311 root cause)
 * 3. Combine with already-escaped header/footer
 * 4. Chunk by UTF-16 code units, ≤4000 per chunk
 * 5. If any chunk fails HTML validation, downgrade ALL chunks to plain text
 *
 * Returns chunks ready for sequential `sendMessage` calls. The first chunk
 * should carry replyMarkup; follow-ups should not.
 */
export function formatForTelegram(
  rawOutput: string,
  header?: string,
  footer?: string,
): TelegramChunk[] {
  const stripped = stripActionBlocks(rawOutput);
  const escaped = escapeAgentHtml(stripped);
  const combined = [header, escaped, footer].filter((s): s is string => Boolean(s)).join("\n\n");

  const chunks = chunkByUtf16Length(combined, MAX_CHUNK_LENGTH);
  const allValid = chunks.every((c) => validateTelegramHtml(c));

  if (allValid) {
    return chunks.map((text) => ({ text, parseMode: "HTML" as const }));
  }

  // Fallback: strip every tag, re-chunk as plain text.
  const plain = stripHtmlToPlain(combined);
  return chunkByUtf16Length(plain, MAX_CHUNK_LENGTH).map((text) => ({
    text,
    parseMode: null,
  }));
}
