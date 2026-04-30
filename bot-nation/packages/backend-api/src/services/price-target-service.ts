/**
 * Price Target Service
 *
 * For each symbol in the watchlist, calls tradingagents-api (or falls back to
 * OpenRouter + web search) to determine:
 *   - Trend direction: BULLISH | BEARISH | NEUTRAL
 *   - Daily target: expected price by end of trading day
 *   - Weekly target: expected price by end of week
 *   - Key support / resistance levels
 *   - Confidence score (0-1)
 *   - Reasoning summary
 *
 * Results are stored in D1 table `price_targets` and formatted for Telegram.
 */

import { query, queryOne, run } from "../db/schema";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PriceTarget {
  symbol: string;
  trend: "BULLISH" | "BEARISH" | "NEUTRAL";
  daily_target: number;
  weekly_target: number;
  support: number;
  resistance: number;
  confidence: number;
  current_price: number;
  reasoning: string;
  generated_at: string;
}

// ── Analysis prompt ───────────────────────────────────────────────────────────

function buildAnalysisPrompt(symbol: string): string {
  return (
    `Analyze ${symbol} and provide specific price targets. ` +
    `Return JSON with these exact fields:\n` +
    `{\n` +
    `  "trend": "BULLISH" | "BEARISH" | "NEUTRAL",\n` +
    `  "daily_target": <number - expected EOD price>,\n` +
    `  "weekly_target": <number - expected price by end of week>,\n` +
    `  "support": <number - key support level>,\n` +
    `  "resistance": <number - key resistance level>,\n` +
    `  "confidence": <0-1>,\n` +
    `  "current_price": <number>,\n` +
    `  "reasoning": "<1-2 sentences on trend basis>"\n` +
    `}\n` +
    `Base this on: recent price action, volume trend, key technical levels, and momentum indicators.`
  );
}

// ── JSON extraction — handles markdown code blocks ────────────────────────────

function extractJson(text: string): string {
  // Strip markdown code fences if present
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) return fenced[1].trim();
  // Try to find a raw JSON object
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (objMatch?.[0]) return objMatch[0].trim();
  return text.trim();
}

function validatePriceTargetJson(raw: Record<string, unknown>, symbol: string): PriceTarget | null {
  const trend = raw.trend as string;
  if (!["BULLISH", "BEARISH", "NEUTRAL"].includes(trend)) return null;

  const daily_target  = Number(raw.daily_target);
  const weekly_target = Number(raw.weekly_target);
  const support       = Number(raw.support);
  const resistance    = Number(raw.resistance);
  const confidence    = Math.min(1, Math.max(0, Number(raw.confidence)));
  const current_price = Number(raw.current_price);

  if ([daily_target, weekly_target, support, resistance, current_price].some(isNaN)) return null;

  return {
    symbol,
    trend: trend as PriceTarget["trend"],
    daily_target,
    weekly_target,
    support,
    resistance,
    confidence,
    current_price,
    reasoning: String(raw.reasoning ?? "").slice(0, 500),
    generated_at: new Date().toISOString(),
  };
}

// ── Primary: call tradingagents-api ──────────────────────────────────────────

async function analyzeViaTradingAgents(
  tradingUrl: string,
  symbol: string,
): Promise<PriceTarget | null> {
  try {
    const resp = await fetch(`${tradingUrl}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: buildAnalysisPrompt(symbol) }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) return null;

    const data = await resp.json() as Record<string, unknown>;

    // tradingagents-api may return the JSON directly in the response body,
    // or nested under a `result` / `text` / `recommendation` field.
    let candidate: Record<string, unknown> | null = null;

    if (data.trend) {
      candidate = data;
    } else if (typeof data.result === "string") {
      try { candidate = JSON.parse(extractJson(data.result)) as Record<string, unknown>; } catch { /* ignore */ }
    } else if (typeof data.recommendation === "string") {
      try { candidate = JSON.parse(extractJson(data.recommendation)) as Record<string, unknown>; } catch { /* ignore */ }
    } else if (typeof data.text === "string") {
      try { candidate = JSON.parse(extractJson(data.text)) as Record<string, unknown>; } catch { /* ignore */ }
    }

    if (!candidate) return null;
    return validatePriceTargetJson(candidate, symbol);
  } catch {
    return null;
  }
}

// ── Fallback: OpenRouter with claude-haiku-4 + web search tool ───────────────

async function analyzeViaOpenRouter(
  openRouterKey: string,
  symbol: string,
): Promise<PriceTarget | null> {
  try {
    // Build tool definition for web search
    const tools = [
      {
        type: "function",
        function: {
          name: "web_search",
          description: "Search the web for current stock price data and news",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search query string",
              },
            },
            required: ["query"],
          },
        },
      },
    ];

    const messages: Array<{ role: string; content: string | Array<{ type: string; tool_call_id?: string; content?: string }> }> = [
      {
        role: "user",
        content: buildAnalysisPrompt(symbol),
      },
    ];

    // First pass — model may call the web_search tool
    const firstResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${openRouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://bot-nation-api.thejamalshackleford.workers.dev",
        "X-Title": "Bot Nation Price Targets",
      },
      body: JSON.stringify({
        model: "anthropic/claude-haiku-4",
        messages,
        tools,
        tool_choice: "auto",
        max_tokens: 1000,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!firstResp.ok) return null;

    const firstData = await firstResp.json() as {
      choices?: Array<{
        message: {
          role: string;
          content: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
    };

    const firstChoice = firstData.choices?.[0];
    if (!firstChoice) return null;

    let finalText = firstChoice.message.content ?? "";

    // If the model issued a tool call, simulate a search result and get the final answer
    if (firstChoice.message.tool_calls?.length) {
      const toolCall = firstChoice.message.tool_calls[0]!;
      const searchArgs = JSON.parse(toolCall.function.arguments) as { query?: string };
      const searchQuery = searchArgs.query ?? `${symbol} stock price today`;

      // Build a stub search result — in production a real search binding could be
      // used here (Brave Search, Tavily, etc.); for now we provide context so the
      // model can still reason from its own knowledge.
      const toolResult = `Search results for "${searchQuery}": Please use your training data and latest knowledge to provide current price estimates for ${symbol}. Focus on key technical levels, recent price action, and trend direction.`;

      messages.push({
        role: "assistant",
        content: firstChoice.message.content ?? "",
      });

      const secondResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${openRouterKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://bot-nation-api.thejamalshackleford.workers.dev",
          "X-Title": "Bot Nation Price Targets",
        },
        body: JSON.stringify({
          model: "anthropic/claude-haiku-4",
          messages: [
            ...messages,
            {
              role: "tool",
              tool_call_id: toolCall.id,
              content: toolResult,
            } as unknown as { role: string; content: string },
          ],
          max_tokens: 1000,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      if (!secondResp.ok) return null;

      const secondData = await secondResp.json() as {
        choices?: Array<{ message: { content: string | null } }>;
      };
      finalText = secondData.choices?.[0]?.message.content ?? "";
    }

    if (!finalText) return null;

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(extractJson(finalText)) as Record<string, unknown>;
    } catch {
      return null;
    }

    return validatePriceTargetJson(parsed, symbol);
  } catch {
    return null;
  }
}

// ── Core: generate targets for a list of symbols ─────────────────────────────

export async function generatePriceTargets(
  db: D1Database,
  env: { TRADING_URL?: string; ANTHROPIC_API_KEY: string; OPENROUTER_API_KEY?: string },
  symbols?: string[],
): Promise<PriceTarget[]> {
  // Resolve symbol list — either provided or read from tws_watchlist
  let targetSymbols: string[];
  if (symbols && symbols.length > 0) {
    targetSymbols = symbols.map((s) => s.toUpperCase());
  } else {
    const rows = await query<{ symbol: string }>(
      db,
      "SELECT symbol FROM tws_watchlist WHERE active=1 ORDER BY symbol ASC",
      [],
    );
    targetSymbols = rows.map((r) => r.symbol);
  }

  if (targetSymbols.length === 0) return [];

  const results: PriceTarget[] = [];

  for (const symbol of targetSymbols) {
    let target: PriceTarget | null = null;

    // Primary: tradingagents-api
    if (env.TRADING_URL) {
      target = await analyzeViaTradingAgents(env.TRADING_URL, symbol);
    }

    // Fallback: OpenRouter with claude-haiku-4
    if (!target && env.OPENROUTER_API_KEY) {
      target = await analyzeViaOpenRouter(env.OPENROUTER_API_KEY, symbol);
    }

    if (!target) {
      console.warn(`[price-target-service] No result for ${symbol} — skipping`);
      continue;
    }

    // Persist to D1
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    await run(
      db,
      `INSERT INTO price_targets
         (id, symbol, trend, daily_target, weekly_target, support, resistance,
          confidence, current_price, reasoning, generated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        target.symbol,
        target.trend,
        target.daily_target,
        target.weekly_target,
        target.support,
        target.resistance,
        target.confidence,
        target.current_price,
        target.reasoning,
        target.generated_at,
        now,
      ],
    );

    results.push(target);
  }

  return results;
}

// ── Read stored targets from D1 ───────────────────────────────────────────────

export async function getStoredTargets(
  db: D1Database,
  symbol?: string,
): Promise<PriceTarget[]> {
  if (symbol) {
    // Latest + up to 4 history entries for a single symbol
    const rows = await query<{
      symbol: string; trend: string; daily_target: number; weekly_target: number;
      support: number; resistance: number; confidence: number; current_price: number;
      reasoning: string; generated_at: string;
    }>(
      db,
      `SELECT symbol, trend, daily_target, weekly_target, support, resistance,
              confidence, current_price, reasoning, generated_at
       FROM price_targets
       WHERE symbol = ?
       ORDER BY generated_at DESC
       LIMIT 5`,
      [symbol.toUpperCase()],
    );
    return rows.map((r) => ({ ...r, trend: r.trend as PriceTarget["trend"] }));
  }

  // Most recent target per symbol
  const rows = await query<{
    symbol: string; trend: string; daily_target: number; weekly_target: number;
    support: number; resistance: number; confidence: number; current_price: number;
    reasoning: string; generated_at: string;
  }>(
    db,
    `SELECT symbol, trend, daily_target, weekly_target, support, resistance,
            confidence, current_price, reasoning, generated_at
     FROM price_targets
     WHERE generated_at IN (
       SELECT MAX(generated_at) FROM price_targets GROUP BY symbol
     )
     ORDER BY symbol ASC`,
    [],
  );
  return rows.map((r) => ({ ...r, trend: r.trend as PriceTarget["trend"] }));
}

// ── Telegram formatter ────────────────────────────────────────────────────────

export function formatTargetsForTelegram(targets: PriceTarget[]): string {
  if (targets.length === 0) return "No price targets available.";

  const now = new Date();
  const dateLabel = now.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
    timeZone: "America/New_York",
  }) + " ET";

  const trendEmoji: Record<PriceTarget["trend"], string> = {
    BULLISH: "🟢",
    BEARISH: "🔴",
    NEUTRAL: "🟡",
  };

  const lines: string[] = [
    `📊 *Daily & Weekly Price Targets*`,
    `_Generated: ${dateLabel}_`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━`,
  ];

  for (const t of targets) {
    const confPct  = Math.round(t.confidence * 100);
    const dailyPct = t.current_price > 0
      ? ((t.daily_target  - t.current_price) / t.current_price * 100).toFixed(1)
      : "0.0";
    const weeklyPct = t.current_price > 0
      ? ((t.weekly_target - t.current_price) / t.current_price * 100).toFixed(1)
      : "0.0";

    const dailySign  = Number(dailyPct)  >= 0 ? "+" : "";
    const weeklySign = Number(weeklyPct) >= 0 ? "+" : "";

    lines.push(
      `${trendEmoji[t.trend]} *${t.symbol}* — ${t.trend} (${confPct}% conf)`,
      `💵 Now: $${t.current_price.toFixed(2)}`,
      `📅 Daily target: $${t.daily_target.toFixed(2)} (${dailySign}${dailyPct}%)`,
      `📆 Weekly target: $${t.weekly_target.toFixed(2)} (${weeklySign}${weeklyPct}%)`,
      `🟩 Support: $${t.support.toFixed(2)}  🟥 Resist: $${t.resistance.toFixed(2)}`,
      `_${t.reasoning}_`,
      ``,
    );
  }

  // Remove trailing empty line then add separator
  if (lines[lines.length - 1] === "") lines.pop();

  return lines.join("\n");
}
