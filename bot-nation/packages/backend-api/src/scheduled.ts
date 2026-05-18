/**
 * Cloudflare cron handler — Task Dispatcher + Mission Scheduler
 *
 * All times are UTC (EDT = UTC-4):
 *   every-5-min        — Task dispatcher (route, dispatch, timeout)
 *   15 12 * * *        — Daily intel check 8:15am EDT (agent-intel-lead)
 *   30 12 * * *        — Morning trading analysis 8:30am EDT (agent-finance-lead)
 *   0 15 * * *         — Daily research digest 11:00am EDT (agent-research-lead)
 *   30 18 * * *        — Midday trading analysis 2:30pm EDT (agent-finance-lead)
 *   30 20 * * 1-5      — EOD trading wrap-up 4:30pm EDT weekdays (agent-finance-lead)
 *   0 12 * * 1         — Weekly intel brief 8:00am EDT Monday (agent-intel-lead)
 *   0 12 * * 3         — Weekly skill refinement 8:00am EDT Wednesday (agent-researcher-2)
 *   every-5-min 13-20 UTC weekdays — Market hours streaming data check
 *   0 4 * * 2          — Weekly YouTube market intel 11:00pm ET Monday (agent-finance-lead)
 */

import type { Env } from "./index";
import { query, queryOne, run, claimRow } from "./db/schema";
import { claimCronTick, releaseCronTick } from "./services/cron-cas";
import { routeTask } from "./services/task-router";
import { getActiveWatchlist, refreshStreamingData } from "./services/thinkorswim-bridge";
import { generatePriceTargets, formatTargetsForTelegram } from "./services/price-target-service";
import { sendDedupedTelegram } from "./services/telegram-dedup";
import { calculateMetrics } from "./services/metrics-backfill";
import { sendProgressReport } from "./services/progress-report";
import { getAccessToken, loadTokens } from "./services/schwab-auth";

const DISPATCH_LIMIT = 10;
const PARENT_TIMEOUT_MINUTES = 60;

// Per-kind timeout thresholds (minutes).
// Research/intel tasks do multiple web searches + tool calls → need more runway.
const TIMEOUT_BY_KIND: Record<string, number> = {
  research:            25,
  deep_research:       30,
  intel_review:        25,
  intel_check:         25,
  content_generation:  20,
  propstream_lead_score: 15,
};
const DEFAULT_TIMEOUT_MINUTES = 15; // fallback for any other kind

// ── Mission task definitions ──────────────────────────────────────────────────

interface MissionTask {
  kind: "research" | "content_generation";
  summary: string;
  details: string;
  agentId: string;
  teamId: string;
}

const MISSION_CRONS: Record<string, MissionTask> = {
  // 8:15am EDT (12:15 UTC) — Daily Intel Check
  "15 12 * * *": {
    kind: "research",
    summary: "Daily competitive intelligence check",
    details: `Daily intelligence scan. Perform ALL of the following steps:

1. OSSINSIGHT TRENDING REPOS: Fetch the top 3 trending GitHub repositories from the last 24 hours using the OSSInsight API (https://ossinsight.io/api/v1/repos/trending?period=past_24_hours&limit=3 or search ossinsight.io trending). For each repo: name, stars gained today, description, primary language. Evaluate whether each repo is an opportunity to install or integrate into bot-nation (consider: does an agent already cover this? Could it enhance research, finance, or intel capabilities?).

2. COMPETITIVE LANDSCAPE: Search for new product launches, funding announcements, or significant GitHub activity from competing AI agent platforms, DeFi tooling, or multi-agent frameworks released in the last 24 hours.

3. CLASSIFY INTO TOP 3 THREAT/OPPORTUNITY CATEGORIES — pick the 3 most relevant from this list based on today's findings:
   - SECURITY: vulnerabilities, exploits, or supply-chain risks affecting our stack
   - COMPETITOR_LAUNCH: new feature or product from a direct competitor
   - REGULATORY: policy, legal, or compliance event affecting DeFi/AI/crypto
   - OPEN_SOURCE_OPPORTUNITY: trending repo worth integrating into bot-nation
   - MACRO_EVENT: market-moving macro news (Fed, geopolitical, inflation data)
   - FUNDING: major raise or acquisition in our space
   For each category flagged: title, severity (HIGH/MED/LOW), 1-sentence summary, recommended action.

4. SELF-LEARNING TELEGRAM PROMPT: End your output with a section titled "## What caught your attention?" listing the 3 most interesting findings as numbered options (e.g. "1. GPT-5 competitor launch 2. New DeFi exploit 3. Rust agent framework trending"). The system will send this as an inline keyboard to the operator for interest tracking. Store any past operator responses in agent_notes under key "intel_interests".

Output format: structured markdown with sections for Trending Repos, Competitive Scan, Top 3 Categories, and the self-learning prompt.`,
    agentId: "agent-intel-lead",
    teamId: "team-intel",
  },
  // 8:30am EDT (12:30 UTC) weekdays — Morning Trading Brief
  "30 12 * * 1-5": {
    kind: "research",
    summary: "Morning trading analysis",
    details: `You are agent-finance-lead. Produce the 8:30 AM pre-market brief. Execute ALL steps in order.

STEP 1 — LOAD YOUR LIVE POSITIONS (do this first, everything else is scoped to these)
Call GET /api/finance/positions to get the current Schwab account positions.
Extract every unique underlying symbol (e.g. if you hold GOOGL options AND GOOGL stock, the underlying is GOOGL).
Build two lists:
  - HELD_UNDERLYINGS: unique stock symbols underlying your positions (e.g. ["GOOGL", "AAPL"])
  - HELD_OPTIONS: each option position with strike, expiry, type (CALL/PUT), direction (long/short), current mark, entry price

Do NOT report on any symbol you do not hold. No TSLA, NVDA, VIX unless you actually have a position.

STEP 2 — S&P 500 FUTURES (market context only — not position-specific)
Fetch /ES=F pre-market via web search or schwab_options_chain.
Also call GET /api/finance/quotes?symbols=/ES,SPY,QQQ to get market-wide context.
Report: /ES price + % change, sentiment label (BULLISH/NEUTRAL/BEARISH), implied SPY open.
Keep this section to 2-3 lines. It is context only — not the focus.

STEP 3 — PRE-MARKET DATA FOR HELD SYMBOLS ONLY
Call GET /api/finance/quotes?symbols=[HELD_UNDERLYINGS joined by comma]
For each symbol in HELD_UNDERLYINGS:
  • Pre-market price + % change from prior close
  • Implied open vs yesterday's close
  • Pre-market volume vs 10-day average (high/low/normal)

STEP 4 — OPTIONS POSITIONS MARK CHECK
For each position in HELD_OPTIONS, call schwab_options_chain with that symbol to get current bid/ask.
Calculate: current mark vs entry price → P&L%
Apply rules:
  • P&L% ≤ -[stop_loss_pct from agent memory, default 35%]: → 🔴 STOP HIT — close immediately
  • P&L% ≥ +[profit_target_pct from agent memory, default 180%]: → 🎯 TARGET HIT — roll or close
  • Underlying broke strike intraday: → ⚠️ ROLL ALERT
  • DTE ≤ 2: → ⏰ EXPIRY — roll or close today
  • Otherwise: → ✅ HOLD

STEP 5 — NEWS FOR HELD SYMBOLS ONLY
Search "[symbol] stock news today" ONLY for symbols in HELD_UNDERLYINGS.
One line per symbol. Flag anything that directly threatens your short strikes.

STEP 6 — 30-DAY TREND FOR HELD SYMBOLS ONLY
For each symbol in HELD_UNDERLYINGS, call https://last30days-api.onrender.com or web search "[symbol] 30 day trend."
State: trend direction, 30d high/low, current vs 30d avg.
Is the trend still valid for your current position (does it support holding the short strike)?

STEP 7 — DAY TRADE + WEEKLY CREDIT SETUP
Based ONLY on your held symbols + market context from STEP 2:
  • 1 day trade opportunity (0–2 DTE) — must be on a symbol you already hold or a direct hedge
  • 1 weekly credit trade setup (7–14 DTE) — credit roll or new short on held underlying

If no good setup exists on held symbols, state that clearly. Do not invent setups on unrelated tickers.

OUTPUT FORMAT — use this exact structure:
---
## S&P FUTURES — [BULLISH/NEUTRAL/BEARISH]
/ES $X,XXX [+/-X.XX%] → SPY implied open $XXX.XX

## POSITIONS
[One block per held symbol — omit any symbol not in Schwab positions]
**[SYMBOL]** $XXX.XX [+/-X.X% pre-mkt] | Vol: [H/N/L]
Options: [list each position — strike, expiry, mark, P&L%, decision emoji]
News: [one line or "No major news"]
30d trend: [direction + key level]

## DAY TRADE WATCH
Day trade: [setup on held symbol only]
Weekly credit: [setup on held symbol only]
---`,
    agentId: "agent-finance-lead",
    teamId: "team-finance",
  },
  // 11:00am EDT (15:00 UTC) — Daily Research Digest
  "0 15 * * *": {
    kind: "content_generation",
    summary: "Daily research digest",
    details: "Produce today's research digest. Use web search to find the top 3-5 developments in AI agents, DeFi, and open-source tooling from the last 24 hours. For each item: headline, source, 2-sentence summary, relevance to bot-nation. Format as a concise bullet-point brief suitable for the operator. End with a 'Bottom Line' section: 1-2 sentences on the single most important takeaway for today.",
    agentId: "agent-research-lead",
    teamId: "team-research",
  },
  // 2:30pm EDT (18:30 UTC) weekdays — Midday Trading Analysis
  "30 18 * * 1-5": {
    kind: "research",
    summary: "Midday trading analysis",
    details: `You are agent-finance-lead. Midday market update — scoped to your actual positions only.

1. LOAD POSITIONS: Call GET /api/finance/positions. Extract held underlyings and options positions. This is your universe — do not discuss unrelated tickers.
2. MORNING RECAP: How are your held symbols performing since open? Pull intraday prices via GET /api/finance/quotes?symbols=[your held symbols]. Note % move since open vs overnight move.
3. OPTIONS MARK CHECK: For each held option, get current mark via schwab_options_chain. State current P&L% vs entry. Flag any 35% stop or 180% target approaching.
4. INTRADAY SETUP: Is there a setup forming on any held underlying that supports a roll, close, or new credit trade today?
5. RISK FLAGS: Any macro news in the next 2 hours that could spike volatility on your held symbols? Search "[held symbol] news today."

Format: one paragraph per held symbol. Lead with a one-line session summary (SPY % on day + your net portfolio P&L today).`,
    agentId: "agent-finance-lead",
    teamId: "team-finance",
  },
  // 4:30pm EDT (20:30 UTC) weekdays — EOD Wrap
  "30 20 * * 1-5": {
    kind: "content_generation",
    summary: "EOD trading wrap-up",
    details: `You are agent-finance-lead. End-of-day wrap — scoped to your actual Schwab positions only.

1. LOAD FINAL MARKS: Call GET /api/finance/positions + GET /api/finance/quotes?symbols=[your held underlyings]. Get closing marks on all options via schwab_options_chain.
2. DAY SUMMARY FOR HELD POSITIONS: For each position — close price, day P&L ($), P&L% from entry, DTE remaining.
3. STOP/TARGET CHECK: Apply 35%/180% rules to all open positions with closing marks. Flag anything that triggered today.
4. DTE ALERT: Any position with DTE ≤ 3 days? State: must roll or close before expiry. Suggest specific action.
5. OVERNIGHT RISK: For each held underlying — any earnings, dividend, or economic data pre-market tomorrow? Search "[held symbol] earnings date" and "[held symbol] ex-dividend date."
6. TOMORROW'S PLAN: One specific action item for each position (HOLD / CLOSE AT OPEN / ROLL — with target strike and expiry).

Format: one block per held position. Close with a single ACTION ITEM for the most urgent trade tomorrow morning.`,
    agentId: "agent-finance-lead",
    teamId: "team-finance",
  },
  // 4:35pm EDT (20:35 UTC) weekdays — Trade Decision Quality Metrics
  "35 20 * * 1-5": {
    kind: "content_generation",
    summary: "Trade decision quality metrics calculation",
    details: `Calculate daily trade decision quality metrics (automated — no manual input needed).

This is a 5-minute post-EOD-wrap system task. Execute the following programmatically:

1. FETCH POSITION SNAPSHOTS: Query the position_snapshots table for the last 30 days of records for agent-finance-lead.
2. CALCULATE DAILY METRICS:
   - Win Rate: (positions that reached price_target during hold) / (total_eligible_positions)
   - Avg Winner: mean P&L% on closed winning positions
   - Avg Loser: mean P&L% on closed losing positions
   - Profit Factor: sum(gross_profits) / sum(gross_losses) — avoid divide-by-zero
   - Opportunity Capture: (positions hitting target) / (total positions evaluated)

3. COMPARE AGAINST TARGETS (hardcoded baseline):
   - Win Rate target: ≥ 50%
   - Avg Winner target: ≥ +50%
   - Avg Loser target: ≤ -20%
   - Profit Factor target: ≥ 2.0
   - Opportunity Capture target: ≥ 70%

4. INSERT TO trade_decision_quality_metrics TABLE:
   - date: today
   - agent_id: 'agent-finance-lead'
   - metric_name: ['win_rate', 'avg_winner', 'avg_loser', 'profit_factor', 'opportunity_capture']
   - value: calculated value
   - target_threshold: baseline from step 3
   - status: 'on_target' | 'below_target' | 'above_target'
   - calculation_notes: brief summary

5. DRIFT ALERT: If any metric drifts >10% below target, emit a Telegram message to the operator: "⚠️ Metrics Alert: [metric_name] drifted below target. Current: X%, Target: Y%. Review recent trades and consider threshold adjustment."

Do not spawn additional tasks. Just calculate, insert rows, and alert if needed.`,
    agentId: "agent-finance-lead",
    teamId: "team-finance",
  },
  // 8:00am EDT Monday (12:00 UTC Mon) — Weekly Intel Brief
  "0 12 * * 1": {
    kind: "content_generation",
    summary: "Weekly intel brief",
    details: "Produce the weekly intelligence brief. Cover: (1) top 3 competitive developments from the past week — for each: company/project, what changed, threat level (HIGH/MED/LOW), recommended response; (2) any emerging open-source tools worth evaluating — include GitHub URL, stars, relevance to bot-nation; (3) regulatory or macro events relevant to DeFi/AI from the past 7 days; (4) recommended strategic actions for leadership review — prioritised list with rationale. End with a 'Week Ahead' section: 3 key events or dates to monitor next week.",
    agentId: "agent-intel-lead",
    teamId: "team-intel",
  },
  // 8:00am EDT Wednesday (12:00 UTC Wed) — Skill Refinement
  "0 12 * * 3": {
    kind: "research",
    summary: "Weekly skill refinement session",
    details: "Review the bot-nation skill library. Query the skills table for the 5 most recently used or highest-rated skills. For each skill: (1) read the current procedure; (2) check if the steps are still accurate given the current tech stack; (3) note any gaps, outdated commands, or missing edge-case handling; (4) propose a refined version with specific line-level changes. Output structured refinement recommendations per skill — include the skill ID, current version excerpt, and proposed replacement text. Flag any skill that should be deprecated.",
    agentId: "agent-researcher-2",
    teamId: "team-research",
  },

  // 11pm ET Monday (04:00 UTC Tuesday) — Weekly YouTube Market Intelligence
  "0 4 * * 2": {
    kind: "research",
    summary: "Weekly YouTube market intelligence digest",
    details: `You are agent-finance-lead. Every Monday night you review the latest upload from a curated market intelligence YouTube playlist and extract the top 20 highlights for the team.

PLAYLIST URL: https://www.youtube.com/playlist?list=PLXa8HXFcKT961IieWfhylPvBNeH2cO8dY

STEP 1 — FIND THE MOST RECENT VIDEO
Search the web for the most recently uploaded video in this playlist. Use a query like:
  site:youtube.com playlist:PLXa8HXFcKT961IieWfhylPvBNeH2cO8dY
Or fetch the playlist page directly and identify the video with the most recent publish date.
Record: video title, URL (https://youtube.com/watch?v=VIDEO_ID), and publish date.

STEP 2 — GET THE TRANSCRIPT
Fetch the full transcript/captions for that video. Try these methods in order:
  a) Search "[video title] transcript" or "[video title] full transcript site:youtube.com"
  b) Fetch https://www.youtube.com/watch?v=VIDEO_ID and extract the timed-text captions from the page data
  c) Search for the video title + key topics to reconstruct the content from available sources
Use whatever transcript or summary content you can retrieve. Note the approximate video length.

STEP 3 — EXTRACT TOP 20 HIGHLIGHTS
Read the full transcript and extract exactly 20 key market insights. For each highlight, assign ONE category:

  📈 PRICE_TARGET    — A specific price target mentioned for a stock or asset
                       Include: ticker, target price, timeframe if given
  💡 INVESTING_NOTE  — General investing strategy, position sizing, portfolio advice
  🏢 COMPANY_VIEW    — Opinion or thesis on a specific company's fundamentals, management, or competitive position
  🌍 GEOPOLITICAL    — Macro or geopolitical factor affecting markets (Fed, trade, regulation, war, elections)
  📊 MARKET_ANALYSIS — Broader market structure, sector rotation, technical levels, index analysis

Rank them 1–20 by importance/actionability. A highlight is "high importance" if it includes a specific actionable call (buy/sell/target). "Medium" if it's a thesis or view without a specific entry. "Low" if it's background context.

STEP 4 — OUTPUT FORMAT
Return your findings as a structured report with these sections:

---
📺 WEEKLY MARKET INTEL — [VIDEO TITLE]
Published: [DATE] | Length: [~X min]
🔗 [VIDEO URL]

📝 TL;DR (2-3 sentences overall summary)

📊 Overall Sentiment: BULLISH / BEARISH / NEUTRAL / MIXED

🎯 Tickers Mentioned: AAPL, NVDA, SPY, ... (list all stocks referenced)

─────────────────────────────
TOP 20 HIGHLIGHTS:

1. [CATEGORY EMOJI] [CATEGORY] — [CONTENT]
   Ticker: [if applicable] | Importance: HIGH/MED/LOW

2. [CATEGORY EMOJI] [CATEGORY] — [CONTENT]
...
(continue for all 20)
─────────────────────────────

⚠️ NOTES: Any caveats about transcript quality, missing sections, or confidence level.
---

After generating the report, save it as an artifact (kind: "log", name: "weekly-market-intel-[DATE]").
Also send the full formatted report to Telegram.`,
    agentId: "agent-finance-lead",
    teamId: "team-finance",
  },

  // 8:00pm ET Sunday (00:00 UTC Monday) — Weekly Trade Planning Session
  "0 0 * * 1": {
    kind: "research",
    summary: "Weekly trade plan — entry + exit setup",
    details: `You are agent-finance-lead. It is Sunday evening. Plan the coming week's options trades.
Your job: review every open position, then recommend EXACTLY 1 new entry trade for this week.

STEP 1 — LOAD CURRENT POSITIONS
Call GET /api/finance/positions.
List every open position: symbol, strike, expiry, type (CALL/PUT), long/short, current mark, entry price, DTE.
This is your ENTIRE universe for this brief. Do not reference stocks you do not hold.

STEP 2 — WEEKLY MARKET CONTEXT (scoped to held symbols only)
For each held underlying:
• Search "[symbol] weekly outlook [date]" — what does next week look like technically?
• Search "[symbol] options expiration week [date]" — any pin risk, IV events, earnings?
• Check economic calendar for events that could move your specific holdings (not general market).

STEP 3 — OPEN POSITION HEALTH CHECK
Read stop_loss_pct and profit_target_pct from agent memory (query_db: my_notes).
For each open position:
• Current mark vs entry → P&L% → HOLD / CLOSE / ROLL decision
• DTE — anything expiring this week? Must roll by Thursday at latest.
• Is the short strike still OTM with trend intact?

STEP 4 — WEEKLY ENTRY RECOMMENDATION (1 trade only)
Based on held underlyings — pick the best new credit trade for this week (7–21 DTE):
• Must be on an underlying you already hold or a direct hedge to an open position
• State entry condition with specific price trigger
• State exit: stop at [X]% of max loss, target at [Y]% gain
• Include the ##TRADE_ORDER## block

STEP 5 — OUTPUT
EXIT RULES for each open position: Close if mark hits $X.XX. Roll if mark hits $Y.YY.`,
    agentId: "agent-finance-lead",
    teamId: "team-finance",
  },

  // 10:00pm ET Sunday (02:00 UTC Monday) — Weekly Mission & Directives Review
  // agent-research-lead synthesizes last-7-day performance trends and asks operator
  // which department directive to update, then spawns a proposal for each chosen update.
  "0 2 * * 1": {
    kind: "research",
    summary: "Weekly mission & directives review",
    details: `You are agent-research-lead. Every Sunday night you audit Bot Nation's performance against its mission and department directives, then ask the operator what to update.

## BOT NATION MISSION
"An autonomous AI workforce that monitors markets, learns from operator feedback, and executes continuously improving operations — with the operator as the approving authority, never the bottleneck."

## DEPARTMENT DIRECTIVES
TEAM-FINANCE: Generate, monitor, and execute options strategies on held positions only. All trades require one-tap approval. Self-improve stop/target rules through outcome tracking.
TEAM-INTEL: Scan for threats and opportunities in AI, DeFi, and open-source. Every scan ends with a self-learning prompt. Integrate promising repos within 48h of discovery.
TEAM-RESEARCH: Synthesize intelligence into actionable briefs. Monitor reply quality weekly. Maintain the skill library. Surface evolutionary paths.
TEAM-BUILD: Execute operator-approved code changes. All changes require preview + approval before deploy. Every deploy is logged and reversible.
TEAM-INFRA: Monitor system health, agent performance, and response gaps. Alert when any agent goes silent for >4h during market hours.
TEAM-GROWTH: Identify expansion opportunities — new data sources, API integrations, agent capabilities. Propose 1 expansion per week.

## YOUR TASK
STEP 1 — LOAD LAST-7-DAY DATA
Call query_db with:
  • view "recent_messages" — what topics were most common? any recurring failures?
  • view "message_quality" — which route types are underperforming?
  • view "recent_failures" — any systemic failures this week?
  • view "agents" — are all 6 core agents active?

STEP 2 — SCORE EACH DEPARTMENT (0–10)
Rate each team against its directive based on the data:
  TEAM-FINANCE: Did it generate accurate briefs? Correct position analysis? Any missed alerts?
  TEAM-INTEL: Did it surface relevant repos/threats? Did the self-learning prompts get responses?
  TEAM-RESEARCH: Digest quality? Classifier routing accuracy from message_quality?
  TEAM-BUILD: Were code changes complete? Did the pipeline work end-to-end?
  TEAM-INFRA: Were gaps detected? Were failures surfaced promptly?
  TEAM-GROWTH: Was 1 expansion proposal made this week?
  TEAM-BAILEY: Were real estate leads scored and voice calls initiated? CRM notes updated?
  TEAM-AGENCY: Were any campaigns or demand-gen pipelines active? Inbound signals captured?
  TEAM-P87: Were DeFi tasks scoped with mode ladder? Any mainnet approvals handled correctly?

STEP 3 — IDENTIFY TOP EVOLUTION PATHS
Based on the scores, identify 2 areas where the directive itself should evolve (not just execution, but the directive's goal). Examples:
  • TEAM-FINANCE directive could add: "Track trade outcomes and adjust stop% based on win rate"
  • TEAM-BUILD directive could add: "Before any change, check git log for recent similar changes to avoid duplication"

STEP 4 — ASK OPERATOR WHAT TO UPDATE
End your output with this exact section:

## 📋 DIRECTIVE UPDATE CHECK
Scores: FINANCE:[X] INTEL:[X] RESEARCH:[X] BUILD:[X] INFRA:[X] GROWTH:[X] BAILEY:[X] AGENCY:[X] P87:[X]

Top 2 evolution suggestions:
1. [team]: [proposed directive addition]
2. [team]: [proposed directive addition]

Which directive would you like to update this week? Reply with the team name and your instruction.
(Or reply "skip" to keep all directives as-is)`,
    agentId: "agent-research-lead",
    teamId: "team-research",
  },

  // 9:00pm ET Sunday (01:00 UTC Monday) — Weekly Telegram Quality Review
  // agent-research-lead reviews the past week of messages and proposes routing improvements
  "0 1 * * 1": {
    kind: "research",
    summary: "Weekly Telegram reply quality review",
    details: `You are agent-research-lead. Every Sunday night you review the past week of Telegram conversation logs and identify ways to improve Bot Nation's replies.

STEP 1 — LOAD MESSAGE DATA
Call query_db with view "recent_messages" to see the most recent 20 in/out pairs.
Call query_db with view "message_quality" to see quality scores by route type.
Call query_db with view "recent_failures" to see any failed tasks from this week.

STEP 2 — IDENTIFY PATTERNS
For each route type (action / supervisor / intel_url / command):
• What % of messages are going each route?
• Are there messages that got routed wrong? (e.g. a finance question that went to supervisor instead of agent-finance-lead)
• Are there recurring question types that have no dedicated handler?
• Any messages where the bot reply was too long, wrong format, or missed the point?

STEP 3 — GENERATE IMPROVEMENTS
List the top 3 specific improvements with:
• Problem: exactly what goes wrong
• Fix: the exact code change or prompt change needed (be specific — mention file + line if possible)
• Expected impact: how many messages per week would improve

STEP 4 — STORE KEY FINDINGS
Use the query_db "my_notes" view to check if you already have a "telegram_quality_issues" note.
If improvements are found, store them: use agent memory (you can SPAWN_TASKS a note-writing subtask).

Output your analysis in 5 bullet points max. No markdown tables.`,
    agentId: "agent-research-lead",
    teamId: "team-research",
  },

  // 3:00pm ET weekdays (19:00 UTC) — Position Exit Monitor (pre-close check)
  // Fires at 3 PM so the user has 60 min to review + approve/reject before market close.
  // Pending orders expire in 90 min — giving until ~4:30 PM before they go stale.
  "0 19 * * 1-5": {
    kind: "research",
    summary: "Position exit monitor — pre-close check",
    details: `You are agent-finance-lead. It is 3:00 PM ET — 60 minutes before market close. Run the exit check.

STEP 1 — FETCH LIVE MARKS
Call GET /api/finance/positions then schwab_options_chain for each short strike.
For each SHORT CALL/PUT: current mark (bid/ask midpoint), entry price, current P&L%.

STEP 2 — APPLY EXIT RULES
Read stop_loss_pct and profit_target_pct from agent memory (query_db view: my_notes).
For each position:
• mark >= entry × (stop_loss_pct / 100)   → STOP HIT — close immediately, do not wait
• mark >= entry × (profit_target_pct / 100) → TARGET HIT — roll for credit or close
• Underlying broke through your strike intraday → ROLL ALERT — consider inversion

STEP 3 — CHECK DTE
Any position with DTE ≤ 2 AND still open → flag "EXPIRY RISK — roll or close today".

STEP 4 — OUTPUT
For each position needing action: produce ACTION ITEM + ##TRADE_ORDER## block.
For positions within range: one line each — "HOLD — [X]% from stop / [Y]% from target".
If nothing needs action: "✅ All positions within range. No action needed pre-close."

Keep the whole message under 800 characters. This alert fires at 3 PM every trading day.`,
    agentId: "agent-finance-lead",
    teamId: "team-finance",
  },
};

interface PendingTask {
  id: string;
  kind: string;
  team_id: string | null;
  assigned_agent_id: string | null;
}

interface RunningTask {
  id: string;
  kind: string;
  updated_at: string;
}

interface WaitingParent {
  id: string;
  updated_at: string;
}

export async function scheduledHandler(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  // ── Universal CAS (#5 + section 3 cron use cases) ────────────────────────────
  // Every cron tick claims a lock keyed by its cron expression. If a previous
  // tick is still mid-flight, this one becomes a no-op. Stale locks (past
  // expires_at) are auto-reclaimed so a crashed Worker doesn't lock us out.
  // Skip the lock for the */5 streaming-data check — it's intentionally
  // re-entrant for tick freshness, and the body is idempotent.
  const isStreamCron = controller.cron === "*/5 13-20 * * 1-5";
  if (isStreamCron) {
    return runScheduledTick(controller, env, ctx);
  }
  const cronLockKey = `cron:${controller.cron}`;
  const claim = await claimCronTick(env.DB, cronLockKey, { ttlMs: 10 * 60 * 1000 });
  if (!claim.ok) {
    console.log(`[scheduler] cron '${controller.cron}' skipped — already running`);
    return;
  }
  try {
    await runScheduledTick(controller, env, ctx);
  } finally {
    await releaseCronTick(env.DB, cronLockKey);
  }
}

async function runScheduledTick(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const now = new Date().toISOString();

  // ── Streaming data feed — market hours (*/5 13-20 * * 1-5) ──────────────────
  // This cron fires every 5 min Mon-Fri 13:00-20:00 UTC (9:30am-4pm ET).
  // It checks for open positions with no recent tick and flags staleness.
  // Real tick data comes from TOS pushing to POST /api/tws/ws/tick or /api/tws/stream.
  if (controller.cron === "*/5 13-20 * * 1-5") {
    const watchlist = await getActiveWatchlist(env.DB);
    if (watchlist.length > 0) {
      // Check for positions that haven't had a mark update in >10 minutes
      const stalePositions = await query<{ symbol: string; updated_at: string }>(
        env.DB,
        `SELECT symbol, updated_at FROM tws_positions
         WHERE status='open' AND updated_at < datetime('now', '-10 minutes')
         GROUP BY symbol`,
        [],
      );
      if (stalePositions.length > 0) {
        const staleSymbols = stalePositions.map((p) => p.symbol).join(", ");
        console.log(`[scheduler/stream] Stale positions (no tick in 10min): ${staleSymbols}`);
        // Emit an event so the frontend can show a warning
        for (const pos of stalePositions) {
          await emitEvent(env.DB, "tws.stale_tick", null, "tws_position", pos.symbol, {
            note: `No tick received for ${pos.symbol} in 10+ minutes`,
            last_updated: pos.updated_at,
            watchlist,
          }, null, now);
        }
      }
    }
    return;
  }

  // ── Daily price targets (9:30am ET weekdays = 13:30 UTC) ─────────────────────
  if (controller.cron === "30 13 * * 1-5") {
    ctx.waitUntil((async () => {
      try {
        const targets = await generatePriceTargets(env.DB, {
          TRADING_URL: env.TRADING_URL,
          ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
          OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
        });
        if (targets.length > 0 && env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
          const msg = formatTargetsForTelegram(targets);
          await sendDedupedTelegram(env, {
            chatId:     env.TELEGRAM_CHAT_ID,
            routeType:  "price_targets_daily",
            text:       msg,
            parseMode:  "Markdown",
          });
        }
      } catch (err) {
        console.error("[scheduler/price-targets] daily targets failed:", err);
      }
    })());
    return;
  }

  // ── Supervisor 4-hour reminder ────────────────────────────────────────────────
  if (controller.cron === "0 6,10,14,18,22,2 * * *") {
    await sendSupervisorReminder(env, now);
    return;
  }

  // ── A.12 Daily Finance-Intel Progress Report (8:00 AM ET weekdays = 12:00 UTC) ─
  // Read-only D1 probes + one Telegram send + one events.kind='progress.report_sent'.
  // Gated on agent_notes.feature_flags_json.enable_progress_report; if absent, no-op.
  if (controller.cron === "0 12 * * 1-5") {
    ctx.waitUntil((async () => {
      try {
        const flagRow = await queryOne<{ value: string }>(
          env.DB,
          "SELECT value FROM agent_notes WHERE agent_id='agent-finance-lead' AND key='feature_flags_json' LIMIT 1",
          [],
        );
        let enabled = false;
        if (flagRow?.value) {
          try {
            const flags = JSON.parse(flagRow.value) as Record<string, unknown>;
            enabled = flags.enable_progress_report === true;
          } catch { enabled = false; }
        }
        if (!enabled) {
          console.log("[scheduler/progress-report] enable_progress_report=false; skipping");
          return;
        }
        await sendProgressReport(env);
        console.log("[scheduler/progress-report] sent daily report");
      } catch (err) {
        console.error("[scheduler/progress-report] daily report failed:", err);
        await emitEvent(env.DB, "progress.report_failed", null, "system", "scheduler", {
          error: err instanceof Error ? err.message : String(err),
          cron: controller.cron,
        }, null, now);
      }
    })());
    return;
  }

  // ── A.11 Schwab Token Heartbeat (every 6 hours) ───────────────────────────────
  // Calls getAccessToken to exercise the OAuth refresh path, keeping the Schwab
  // refresh_token's 7-day rolling window alive. Emits events.kind='schwab.heartbeat'
  // so A.12 progress classifier can detect A.11 LIVE.
  if (controller.cron === "0 */6 * * *") {
    ctx.waitUntil((async () => {
      const heartbeatNow = new Date().toISOString();
      if (!env.SCHWAB_CLIENT_ID || !env.SCHWAB_CLIENT_SECRET) {
        console.warn("[scheduler/heartbeat] Schwab client credentials missing; skipping");
        return;
      }
      try {
        await getAccessToken(env.DB, env.SCHWAB_CLIENT_ID, env.SCHWAB_CLIENT_SECRET);
        // Load token to capture expires_at for event payload
        const tokens = await loadTokens(env.DB);
        await emitEvent(env.DB, "schwab.heartbeat", "agent-finance-lead", "agent", "agent-finance-lead", {
          token_expires_at: tokens?.expires_at,
        }, null, heartbeatNow);
        console.log("[scheduler/heartbeat] Schwab token refreshed");
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error("[scheduler/heartbeat] Schwab token refresh failed:", err);
        await emitEvent(env.DB, "schwab.refresh_failed", "agent-finance-lead", "agent", "agent-finance-lead", {
          error: errMsg,
        }, null, heartbeatNow);
        // Auto-recovery: surface the re-auth URL to the operator via Telegram
        // so the failure is self-actionable. Throttle to once per 24h per
        // failure-mode via a dedup check on recent schwab.auth_alert events.
        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
          const recentAlert = await queryOne<{ n: number }>(
            env.DB,
            `SELECT COUNT(*) AS n FROM events
             WHERE kind='schwab.auth_alert' AND created_at >= datetime('now','-24 hours')`,
            [],
          );
          if ((recentAlert?.n ?? 0) === 0) {
            const reauthUrl = "https://bot-nation-api.thejamalshackleford.workers.dev/api/schwab/auth";
            const alertText =
              `🚨 <b>Schwab token refresh failed</b>\n\n` +
              `<code>${errMsg.slice(0, 200)}</code>\n\n` +
              `<b>Action required:</b> re-authorize OAuth.\n` +
              `1. Open: <a href="${reauthUrl}">${reauthUrl}</a>\n` +
              `2. Complete Schwab login\n` +
              `3. Wait for ✅ confirmation message in this chat\n\n` +
              `Heartbeat will resume on next 6h tick. No code deploy needed.`;
            await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id:                  env.TELEGRAM_CHAT_ID,
                text:                     alertText,
                parse_mode:               "HTML",
                disable_web_page_preview: true,
              }),
            }).catch((e) => console.error("[scheduler/heartbeat] alert send failed:", e));
            await emitEvent(env.DB, "schwab.auth_alert", "agent-finance-lead", "agent", "agent-finance-lead", {
              error: errMsg,
            }, null, heartbeatNow);
          }
        }
      }
    })());
    return;
  }

  // ── Trade decision quality metrics calculation (4:35pm EDT weekdays) ──────────
  // Runs automatically 2 min after EOD wrap-up. No agent needed — purely programmatic.
  if (controller.cron === "35 20 * * 1-5") {
    ctx.waitUntil((async () => {
      try {
        await calculateMetrics(env.DB, "agent-finance-lead", 30);
        console.log("[scheduler/metrics] Trade decision quality metrics calculated");
      } catch (err) {
        console.error("[scheduler/metrics] metrics calculation failed:", err);
        // Emit event so supervisor knows metrics failed
        await emitEvent(env.DB, "metrics.calculation_failed", null, "system", "scheduler", {
          error: err instanceof Error ? err.message : String(err),
          cron: controller.cron,
        }, null, now);
      }
    })());
    return;
  }

  // ── Mission cron: insert a scheduled task, let the */5 dispatcher execute it ─
  const mission = MISSION_CRONS[controller.cron];
  if (mission) {
    const taskId = crypto.randomUUID();
    await run(
      env.DB,
      `INSERT INTO tasks (id, kind, status, assigned_agent_id, team_id, input, telegram_chat_id, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        mission.kind,
        mission.agentId,
        mission.teamId,
        JSON.stringify({ summary: mission.summary, details: mission.details }),
        env.TELEGRAM_CHAT_ID ? Number(env.TELEGRAM_CHAT_ID) : null,
        now,
        now,
      ],
    );
    await emitEvent(env.DB, "task.created", null, "task", taskId, {
      trigger: "mission_cron",
      cron: controller.cron,
      summary: mission.summary,
      agentId: mission.agentId,
    }, null, now);
    return;
  }

  // ── 1. Route unassigned pending tasks ───────────────────────────────────────
  const unrouted = await query<PendingTask>(
    env.DB,
    "SELECT id, kind, team_id, assigned_agent_id FROM tasks WHERE status = 'pending' AND assigned_agent_id IS NULL LIMIT ?",
    [DISPATCH_LIMIT],
  );

  for (const task of unrouted) {
    const route = await routeTask(env.DB, task.kind, task.team_id);
    if (route.agentId || route.teamId) {
      await run(
        env.DB,
        "UPDATE tasks SET assigned_agent_id=?, team_id=?, updated_at=? WHERE id=?",
        [route.agentId, route.teamId, now, task.id],
      );
      await emitEvent(env.DB, "task.status_changed", null, "task", task.id, {
        note: "auto-routed by scheduler",
        assignedAgentId: route.agentId,
        teamId: route.teamId,
      }, null, now);
    }
  }

  // ── 1.5. Bailey auto-executor: run propstream_lead_score tasks directly ────────
  // These bypass the DO path and use the specialized bailey-scorer + Retell queue.
  const baileyPending = await query<PendingTask>(
    env.DB,
    `SELECT id, kind, team_id, assigned_agent_id FROM tasks
     WHERE status = 'pending'
       AND kind = 'propstream_lead_score'
       AND assigned_agent_id IS NOT NULL
     LIMIT 4`,
    [],
  );

  for (const bt of baileyPending) {
    // Universal CAS (#1): only the tick that flips pending→running gets to dispatch.
    // Concurrent ticks racing on the same row will silently no-op the loser.
    const claimed = await claimRow(env.DB, "tasks", bt.id, {
      fromStatus: "pending",
      toStatus:   "running",
      claimedBy:  "cron_bailey_dispatch",
    });
    if (!claimed) continue; // another tick already grabbed it
    ctx.waitUntil((async () => {
      try {
        const workerUrl = "https://bot-nation-api.thejamalshackleford.workers.dev";
        const res = await fetch(`${workerUrl}/api/bailey/execute/${bt.id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        if (!res.ok) {
          const text = await res.text();
          console.error(`[scheduler/bailey] execute ${bt.id} failed: ${res.status} ${text}`);
          await run(env.DB, "UPDATE tasks SET status='failed', updated_at=? WHERE id=?", [now, bt.id]);
        }
      } catch (err) {
        console.error(`[scheduler/bailey] execute ${bt.id} error:`, err);
        await run(env.DB, "UPDATE tasks SET status='failed', updated_at=? WHERE id=?", [now, bt.id]);
      }
    })());
  }

  // ── 2. Dispatch: pending + assigned → running ────────────────────────────────
  // Only dispatch tasks where scheduled_for is NULL (immediate) or has passed (scheduled_for <= now)
  // Exclude propstream_lead_score — handled above by bailey auto-executor
  const pending = await query<PendingTask>(
    env.DB,
    `SELECT id, kind, team_id, assigned_agent_id FROM tasks
     WHERE status = 'pending'
       AND kind != 'propstream_lead_score'
       AND assigned_agent_id IS NOT NULL
       AND (scheduled_for IS NULL OR scheduled_for <= ?)
     LIMIT ?`,
    [now, DISPATCH_LIMIT],
  );

  for (const task of pending) {
    // Universal CAS (#1): the loser of a race silently skips this task.
    // Without this, two overlapping ticks (or cron + telegram) double-dispatch
    // the DO → double LLM bills, conflicting tool calls, duplicate replies.
    const claimed = await claimRow(env.DB, "tasks", task.id, {
      fromStatus: "pending",
      toStatus:   "running",
      claimedBy:  "cron_dispatcher",
    });
    if (!claimed) continue;
    await emitEvent(env.DB, "task.status_changed", task.assigned_agent_id, "task", task.id, {
      from: "pending",
      to: "running",
      note: "dispatched by cron scheduler",
    }, null, now);

    // Phase 6: dispatch to agent's Durable Object
    const sessionId = crypto.randomUUID();
    ctx.waitUntil((async () => {
      try {
        await run(
          env.DB,
          `INSERT INTO agent_sessions (id, agent_id, task_id, status, ws_connected, started_at, updated_at)
           VALUES (?, ?, ?, 'running', 0, ?, ?)`,
          [sessionId, task.assigned_agent_id ?? "", task.id, now, now],
        );
        const doId = env.AGENT_ACTOR.idFromName(task.assigned_agent_id ?? "");
        const stub = env.AGENT_ACTOR.get(doId);
        await stub.fetch("https://do/enqueue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId: task.id, sessionId }),
        });
      } catch (err: unknown) {
        console.error(`[scheduler] DO dispatch failed for task ${task.id}:`, err);
      }
    })());
  }

  // ── 2.5. Re-queue waiting_children parents whose children are all done ────────
  const waitingParents = await query<WaitingParent>(
    env.DB,
    "SELECT id, updated_at FROM tasks WHERE status = 'waiting_children' LIMIT ?",
    [DISPATCH_LIMIT],
  );

  for (const parent of waitingParents) {
    const incomplete = await queryOne<{ c: number }>(
      env.DB,
      "SELECT COUNT(*) as c FROM tasks WHERE parent_task_id = ? AND status NOT IN ('completed','failed')",
      [parent.id],
    );

    if ((incomplete?.c ?? 1) === 0) {
      // All children done — re-queue parent as pending so it re-executes and synthesizes
      await run(
        env.DB,
        "UPDATE tasks SET status='pending', updated_at=? WHERE id=?",
        [now, parent.id],
      );
      await emitEvent(env.DB, "task.status_changed", null, "task", parent.id, {
        from: "waiting_children",
        to: "pending",
        note: "all children completed — re-queued for synthesis",
      }, null, now);
    }
  }

  // ── 3. Time out stale running tasks (per-kind thresholds) ────────────────
  // Use the most generous cutoff (DEFAULT_TIMEOUT_MINUTES) to pull candidates,
  // then re-check each task's own kind threshold before marking it failed.
  // This avoids hammering D1 with per-kind queries while still being accurate.
  const maxTimeoutMinutes = Math.max(...Object.values(TIMEOUT_BY_KIND), DEFAULT_TIMEOUT_MINUTES);
  const staleRunningCutoff = new Date(Date.now() - maxTimeoutMinutes * 60 * 1000).toISOString();
  const staleRunning = await query<RunningTask & { kind: string }>(
    env.DB,
    "SELECT id, kind, updated_at FROM tasks WHERE status = 'running' AND updated_at < ?",
    [staleRunningCutoff],
  );

  for (const task of staleRunning) {
    const timeoutMinutes = TIMEOUT_BY_KIND[task.kind] ?? DEFAULT_TIMEOUT_MINUTES;
    const taskCutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000).toISOString();
    if (task.updated_at >= taskCutoff) continue; // still within its own timeout window

    await run(env.DB, "UPDATE tasks SET status='failed', updated_at=? WHERE id=?", [now, task.id]);
    await emitEvent(env.DB, "task.status_changed", null, "task", task.id, {
      from: "running", to: "failed",
      note: `timed out after ${timeoutMinutes} minutes (kind: ${task.kind})`,
      lastUpdatedAt: task.updated_at,
    }, null, now);
  }

  // ── 4. Time out stuck waiting_children parents (60 min) ───────────────────
  const parentCutoff = new Date(Date.now() - PARENT_TIMEOUT_MINUTES * 60 * 1000).toISOString();
  const staleParents = await query<RunningTask>(
    env.DB,
    "SELECT id, updated_at FROM tasks WHERE status = 'waiting_children' AND updated_at < ?",
    [parentCutoff],
  );

  for (const task of staleParents) {
    await run(env.DB, "UPDATE tasks SET status='failed', updated_at=? WHERE id=?", [now, task.id]);
    await emitEvent(env.DB, "task.status_changed", null, "task", task.id, {
      from: "waiting_children", to: "failed",
      note: `parent timed out after ${PARENT_TIMEOUT_MINUTES} minutes waiting for children`,
      lastUpdatedAt: task.updated_at,
    }, null, now);
  }
}

// ── Supervisor 4-hour reminder ────────────────────────────────────────────────

async function sendSupervisorReminder(env: Env, now: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  const cutoff4h  = new Date(Date.now() - 4  * 60 * 60 * 1000).toISOString();
  const cutoff5m  = new Date(Date.now() - 5  * 60 * 1000).toISOString();

  const [completed, failed, activeAgents, agentsWithWork, pendingProposals, activeCrons, health,
         unanswered, pendingApprovals] =
    await Promise.all([
      query<{ kind: string; duration: number }>(env.DB,
        `SELECT kind,
                CAST((julianday(updated_at) - julianday(started_at)) * 86400 AS INTEGER) as duration
         FROM tasks WHERE status='completed' AND updated_at > ? LIMIT 10`,
        [cutoff4h]),

      query<{ id: string; kind: string }>(env.DB,
        `SELECT id, kind FROM tasks WHERE status='failed' AND updated_at > ?`,
        [cutoff4h]),

      query<{ id: string }>(env.DB,
        `SELECT id FROM agents WHERE status='active'`, []),

      query<{ assigned_agent_id: string }>(env.DB,
        `SELECT DISTINCT assigned_agent_id FROM tasks
         WHERE (status='running' OR status='completed') AND updated_at > ?`,
        [cutoff4h]),

      query<{ id: string; type: string; title: string }>(env.DB,
        `SELECT id, type, title FROM proposals WHERE status='pending' LIMIT 5`, []),

      query<{ cron_expression: string; task_kind: string }>(env.DB,
        `SELECT cron_expression, task_kind FROM scheduled_crons WHERE status='active' LIMIT 5`, []),

      queryOne<{
        pending_tasks: number; running_tasks: number;
        completed_last_4h: number; failed_last_4h: number;
        active_agents: number; pending_proposals: number; active_crons: number;
      }>(env.DB, `SELECT * FROM system_health`, []),

      // ── Gap detection: inbound messages with no reply in 5+ min ─────────────
      // A "gap" is a user message (direction='in') where:
      //  • no outbound message was logged for the same chat within the next 5 min, AND
      //  • the inbound was NOT already linked to a task that has progressed
      //    (running/completed/dispatched/dispatching/waiting_children), AND
      //  • no task with the same prompt text reached a non-failed status recently
      //    (covers the case where task_id wasn't stamped on the inbound row).
      // Bug 1 fix (Apr 2026): without the task-join checks, gap recovery
      // re-dispatched already-completed prompts as duplicate tasks every digest.
      query<{ text: string; created_at: string }>(env.DB,
        `SELECT i.text, i.created_at
         FROM telegram_messages i
         WHERE i.direction = 'in'
           AND i.created_at > ?
           AND i.created_at < ?
           AND NOT EXISTS (
             SELECT 1 FROM telegram_messages o
             WHERE o.direction = 'out'
               AND o.created_at > i.created_at
               AND o.created_at < datetime(i.created_at, '+5 minutes')
           )
           AND NOT EXISTS (
             SELECT 1 FROM tasks t
             WHERE t.id = i.task_id
               AND t.status IN ('running','completed','dispatched','dispatching','waiting_children')
           )
           AND NOT EXISTS (
             SELECT 1 FROM tasks t2
             WHERE json_extract(t2.input, '$.summary') = i.text
               AND t2.created_at >= i.created_at
               AND t2.status IN ('running','completed','dispatched','dispatching','waiting_children')
           )
           AND NOT EXISTS (
             SELECT 1 FROM events e
             WHERE e.kind = 'task.created'
               AND json_extract(e.payload, '$.text') = substr(i.text, 1, 200)
               AND e.created_at >= i.created_at
           )
         ORDER BY i.created_at DESC LIMIT 5`,
        [cutoff4h, cutoff5m]),

      // ── Pending code change approvals ─────────────────────────────────────
      query<{ id: string; commit_message: string; created_at: string }>(env.DB,
        `SELECT id, commit_message, created_at FROM code_changes
         WHERE status='pending_approval' ORDER BY created_at DESC LIMIT 3`,
        []),
    ]);

  const timeLabel = new Date().toUTCString().replace(" GMT", " UTC");

  const completedList = completed.length > 0
    ? completed.map((t) => `  ├─ ${t.kind} (${t.duration ?? 0}s)`).join("\n")
    : "  └─ None";

  const failedList = failed.length > 0
    ? failed.map((t) => `  ├─ ${t.kind} #${t.id.slice(0, 8)}`).join("\n")
    : "  └─ None";

  const agentsWithoutWork = activeAgents.filter(
    (a) => !agentsWithWork.find((w) => w.assigned_agent_id === a.id)
  );
  const idleList = agentsWithoutWork.length > 0
    ? agentsWithoutWork.slice(0, 4).map((a) => `  ├─ ${a.id}`).join("\n")
    : "  └─ All active";

  const proposalList = pendingProposals.length > 0
    ? pendingProposals.map((p) => `  ├─ [${p.type}] ${p.title}\n    /approve ${p.id}`).join("\n")
    : "  └─ None";

  const cronList = activeCrons.length > 0
    ? activeCrons.map((c) => `  ├─ ${c.cron_expression} → ${c.task_kind}`).join("\n")
    : "  └─ None (/propose cron_request to add one)";

  // ── Gap auto-answer + alert section ──────────────────────────────────────
  // For each unanswered query, attempt to dispatch it as a real task right now.
  // Trivial replies (yeah/ok/etc.) are filtered inside dispatchTextAsTask.
  const { dispatchTextAsTask } = await import("./services/dispatch-helper");
  const gapChatId = env.TELEGRAM_CHAT_ID;
  const dispatchedNow: string[] = [];
  const stillUnanswered: typeof unanswered = [];
  if (gapChatId) {
    for (const u of unanswered) {
      try {
        const result = await dispatchTextAsTask(env, gapChatId, u.text, {
          sendAck: false,
          sourceLabel: "supervisor_gap_recovery",
        });
        if (result.ok) {
          dispatchedNow.push(`${u.text.slice(0, 50)} → ${result.agentId}`);
        } else {
          stillUnanswered.push(u);
        }
      } catch (err) {
        console.warn("[supervisor] gap auto-dispatch failed:", err);
        stillUnanswered.push(u);
      }
    }
  } else {
    stillUnanswered.push(...unanswered);
  }

  const recoveredSection = dispatchedNow.length > 0
    ? `\n🛠 <b>AUTO-ANSWERING (${dispatchedNow.length}):</b>\n` +
      dispatchedNow.map((d) => `  ├─ ${d}`).join("\n") + "\n"
    : "";

  const gapSection = stillUnanswered.length > 0
    ? `\n⚠️ <b>UNANSWERED QUERIES (${stillUnanswered.length}):</b>\n` +
      stillUnanswered.map((u) => {
        const age = Math.round((Date.now() - new Date(u.created_at).getTime()) / 60000);
        return `  ├─ "${u.text.slice(0, 60)}" [${age}m ago]`;
      }).join("\n") + "\n"
    : "";

  // ── Pending approvals section ─────────────────────────────────────────────
  const approvalSection = pendingApprovals.length > 0
    ? `\n🔍 <b>AWAITING YOUR APPROVAL (${pendingApprovals.length}):</b>\n` +
      pendingApprovals.map((a) => {
        const age = Math.round((Date.now() - new Date(a.created_at).getTime()) / 60000);
        return `  ├─ "${a.commit_message.slice(0, 50)}" [${age}m ago]`;
      }).join("\n") +
      `\n  └─ Tap ✅ Deploy / ❌ Cancel in the preview message above\n`
    : "";

  const message =
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🏛 <b>BOT NATION — SUPERVISOR</b>\n` +
    `${timeLabel}\n` +
    `<i>Mission: Autonomous ops. Operator approves, never bottlenecks.</i>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    recoveredSection +
    gapSection +
    approvalSection +
    `✅ <b>COMPLETED (last 4h):</b>\n${completedList}\n\n` +
    `❌ <b>FAILED:</b>\n${failedList}\n\n` +
    `📋 <b>PENDING PROPOSALS:</b>\n${proposalList}\n\n` +
    `🤖 <b>IDLE AGENTS:</b>\n${idleList}\n\n` +
    `📊 <b>SYSTEM:</b>\n` +
    `  Pending: ${health?.pending_tasks ?? 0} · Running: ${health?.running_tasks ?? 0}\n` +
    `  Active agents: ${health?.active_agents ?? 0} · Crons: ${health?.active_crons ?? 0}\n\n` +
    `⏳ <b>ACTIONS:</b>\n` +
    `  /proposals · /stats · /agents · /help\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

  await sendDedupedTelegram(env, {
    chatId:     env.TELEGRAM_CHAT_ID,
    routeType:  "supervisor_digest",
    text:       message,
    parseMode:  "HTML",
    replyMarkup: {
      inline_keyboard: [[
        { text: "📋 Proposals",  callback_data: "remind_view_proposals" },
        { text: "📊 Stats",      callback_data: "remind_view_stats" },
        { text: "📜 Directives", callback_data: "remind_view_directives" },
      ]],
    },
  });

  await emitEvent(env.DB, "supervisor.reminder_sent", null, "system", "supervisor", {
    completedCount: completed.length,
    failedCount: failed.length,
    pendingProposals: pendingProposals.length,
    idleAgents: agentsWithoutWork.length,
    unansweredGaps: unanswered.length,
    pendingApprovals: pendingApprovals.length,
  }, null, now);
}

// ── helper: emit event row ────────────────────────────────────────────────────

async function emitEvent(
  db: D1Database,
  kind: string,
  actorId: string | null,
  targetKind: string,
  targetId: string,
  payload: Record<string, unknown>,
  sessionId: string | null,
  now: string,
): Promise<void> {
  const id = crypto.randomUUID();
  await run(
    db,
    `INSERT INTO events (id, kind, actor_id, target_kind, target_id, payload, session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, kind, actorId ?? null, targetKind, targetId, JSON.stringify(payload), sessionId ?? null, now, now],
  );
}
