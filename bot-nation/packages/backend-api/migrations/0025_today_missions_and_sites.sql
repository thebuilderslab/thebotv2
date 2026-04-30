-- Migration 0025: Today's one-off mission tasks + agency site management + ATTOM reminder
-- Run: npx wrangler d1 migrations apply pbot-nation-db --remote
--
-- Today's tasks are staggered starting at 1:40pm EDT (17:40 UTC), 3 minutes apart:
--   17:40 UTC — Daily Intel Check
--   17:43 UTC — Morning Trading Analysis
--   17:45 UTC — Midday Trading Analysis
--   17:48 UTC — Weekly Intel Brief
--   17:50 UTC — Skill Refinement Session
--   17:53 UTC — Daily Research Digest
--   17:55 UTC — ATTOM Data reminder (Bailey group)

INSERT INTO tasks (
  id, kind, status, assigned_agent_id, team_id, input, telegram_chat_id,
  scheduled_for, created_at, updated_at
)
VALUES

  -- 1:40pm EDT (17:40 UTC) — Daily Intel Check
  (
    'today-intel-check-001',
    'research', 'pending', 'agent-intel-lead', 'team-intel',
    json_object(
      'summary', 'Daily competitive intelligence check',
      'details', 'Daily intelligence scan. Perform ALL of the following steps:

1. OSSINSIGHT TRENDING REPOS: Fetch the top 3 trending GitHub repositories from the last 24 hours using the OSSInsight API (https://ossinsight.io/api/v1/repos/trending?period=past_24_hours&limit=3 or search ossinsight.io trending). For each repo: name, stars gained today, description, primary language. Evaluate whether each repo is an opportunity to install or integrate into bot-nation (consider: does an agent already cover this? Could it enhance research, finance, or intel capabilities?).

2. COMPETITIVE LANDSCAPE: Search for new product launches, funding announcements, or significant GitHub activity from competing AI agent platforms, DeFi tooling, or multi-agent frameworks released in the last 24 hours.

3. CLASSIFY INTO TOP 3 THREAT/OPPORTUNITY CATEGORIES — pick the 3 most relevant from this list based on today''s findings:
   - SECURITY: vulnerabilities, exploits, or supply-chain risks affecting our stack
   - COMPETITOR_LAUNCH: new feature or product from a direct competitor
   - REGULATORY: policy, legal, or compliance event affecting DeFi/AI/crypto
   - OPEN_SOURCE_OPPORTUNITY: trending repo worth integrating into bot-nation
   - MACRO_EVENT: market-moving macro news (Fed, geopolitical, inflation data)
   - FUNDING: major raise or acquisition in our space
   For each category flagged: title, severity (HIGH/MED/LOW), 1-sentence summary, recommended action.

4. SELF-LEARNING TELEGRAM PROMPT: End your output with a section titled "## What caught your attention?" listing the 3 most interesting findings as numbered options. The system will send this as an inline keyboard to the operator for interest tracking. Store any past operator responses in agent_notes under key "intel_interests".

Output format: structured markdown with sections for Trending Repos, Competitive Scan, Top 3 Categories, and the self-learning prompt.'
    ),
    NULL,
    '2026-04-17 17:40:00',
    datetime('now'), datetime('now')
  ),

  -- 1:43pm EDT (17:43 UTC) — Morning Trading Analysis
  (
    'today-morning-trading-001',
    'research', 'pending', 'agent-finance-lead', 'team-finance',
    json_object(
      'summary', 'Morning trading analysis',
      'details', 'Pre-market and intraday morning trading analysis. Timeframes covered: INTRADAY (0DTE-3DTE), SWING (1-3 weeks), POSITION (1-3 months).

Research and produce a structured brief covering:
1. MACRO CONTEXT: Overnight futures action, key economic releases today (CPI, FOMC, earnings), VIX level and trend.
2. WATCHLIST SCAN (INTRADAY): Review TSLA, SPY, GOOGL, ORCL current premarket prices, overnight % change, volume vs average. Flag any gap-up/gap-down >1%.
3. OPTIONS FOCUS: For each watchlist symbol with open positions — check current DTE, current mark vs entry, any adjustment signals (delta drift >0.30, loss >15%). Flag URGENT if DTE <= 7.
4. SWING SETUPS: Identify 1-2 swing trade candidates (1-3 week hold) with defined entry, target, stop.
5. POSITION IDEAS: Note any long-duration opportunity worth sizing into (1-3 month thesis).
6. MORNING SIGNALS: List up to 3 high-conviction actionable signals with: Symbol | Timeframe | Direction | Entry | Target | Stop | Confidence %.

Format: structured markdown. Lead with a one-line market sentiment summary (BULLISH / NEUTRAL / BEARISH) and current SPY price.'
    ),
    NULL,
    '2026-04-17 17:43:00',
    datetime('now'), datetime('now')
  ),

  -- 1:45pm EDT (17:45 UTC) — Midday Trading Analysis
  (
    'today-midday-trading-001',
    'research', 'pending', 'agent-finance-lead', 'team-finance',
    json_object(
      'summary', 'Midday trading analysis',
      'details', 'Midday market update. Timeframes covered: INTRADAY (active today), SWING (open swing positions).

1. MORNING RECAP: How did morning signals play out? Check TSLA, SPY, GOOGL, ORCL price action since open. Note any signals that triggered.
2. INTRADAY SETUPS NOW: Identify any intraday setups forming in the current session — flag direction, entry zone, invalidation level. Focus on high-probability continuation or reversal patterns.
3. OPEN POSITION REVIEW: For each open options position — current mark, P/L%, DTE, delta. Flag any position needing adjustment or roll.
4. AFTERNOON WATCH: List 1-2 tickers to watch into the close with thesis (news catalyst, technical setup, options expiry pin).
5. RISK FLAGS: Note any macro or news events hitting in the next 2 hours that could spike volatility.

Format: structured markdown. Lead with a one-line current session summary (direction + SPY % on day).'
    ),
    NULL,
    '2026-04-17 17:45:00',
    datetime('now'), datetime('now')
  ),

  -- 1:48pm EDT (17:48 UTC) — Weekly Intel Brief
  (
    'today-weekly-intel-001',
    'content_generation', 'pending', 'agent-intel-lead', 'team-intel',
    json_object(
      'summary', 'Weekly intel brief',
      'details', 'Produce the weekly intelligence brief. Cover: (1) top 3 competitive developments from the past week — for each: company/project, what changed, threat level (HIGH/MED/LOW), recommended response; (2) any emerging open-source tools worth evaluating — include GitHub URL, stars, relevance to bot-nation; (3) regulatory or macro events relevant to DeFi/AI from the past 7 days; (4) recommended strategic actions for leadership review — prioritised list with rationale. End with a "Week Ahead" section: 3 key events or dates to monitor next week.'
    ),
    NULL,
    '2026-04-17 17:48:00',
    datetime('now'), datetime('now')
  ),

  -- 1:50pm EDT (17:50 UTC) — Skill Refinement Session
  (
    'today-skill-refinement-001',
    'research', 'pending', 'agent-researcher-2', 'team-research',
    json_object(
      'summary', 'Weekly skill refinement session',
      'details', 'Review the bot-nation skill library. Query the skills table for the 5 most recently used or highest-rated skills. For each skill: (1) read the current procedure; (2) check if the steps are still accurate given the current tech stack; (3) note any gaps, outdated commands, or missing edge-case handling; (4) propose a refined version with specific line-level changes. Output structured refinement recommendations per skill — include the skill ID, current version excerpt, and proposed replacement text. Flag any skill that should be deprecated.'
    ),
    NULL,
    '2026-04-17 17:50:00',
    datetime('now'), datetime('now')
  ),

  -- 1:53pm EDT (17:53 UTC) — Daily Research Digest
  (
    'today-research-digest-001',
    'content_generation', 'pending', 'agent-research-lead', 'team-research',
    json_object(
      'summary', 'Daily research digest',
      'details', 'Produce today''s research digest. Use web search to find the top 3-5 developments in AI agents, DeFi, and open-source tooling from the last 24 hours. For each item: headline, source, 2-sentence summary, relevance to bot-nation. Format as a concise bullet-point brief suitable for the operator. End with a "Bottom Line" section: 1-2 sentences on the single most important takeaway for today.'
    ),
    NULL,
    '2026-04-17 17:53:00',
    datetime('now'), datetime('now')
  ),

  -- 1:55pm EDT (17:55 UTC) — ATTOM Data reminder for Bailey group
  (
    'today-attom-reminder-001',
    'content_generation', 'pending', 'agent-research-lead', 'team-research',
    json_object(
      'summary', 'ATTOM Data integration opportunity — Bailey group',
      'details', 'Research ATTOM Data (https://www.attomdata.com/data/) as a potential data source for the Bailey group real estate workflows. Produce a brief covering:

1. WHAT ATTOM OFFERS: Key data products available (property data, AVM valuations, foreclosure/pre-foreclosure, neighborhood data, school data, deed/mortgage records, rental data). Note which APIs are relevant to real estate investment, lead generation, or deal analysis.

2. BAILEY GROUP FIT: The Bailey group handles real estate intake and client workflows (see Propstream integration and Bailey routes). Identify the top 3 use cases where ATTOM data would enhance existing Bailey tasks — e.g. automated property valuations on intake, pre-foreclosure lead lists, neighborhood scoring for deal analysis.

3. INTEGRATION PATH: Describe how ATTOM could plug into bot-nation (new /api/attom/* route, new propstream-style service file, scheduled cron for fresh data pulls). Note pricing tier considerations (free tier vs paid API key).

4. RECOMMENDED ACTION: Should the operator sign up for an ATTOM API key? What is the first integration to build?

Send this as a Telegram notification to the operator with the subject: "ATTOM Data — Worth integrating for Bailey group?" and include the URL https://www.attomdata.com/data/ for review.'
    ),
    NULL,
    '2026-04-17 17:55:00',
    datetime('now'), datetime('now')
  );

-- ── Agency site management tables ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agency_sites (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  repo_path     TEXT,
  pages_project TEXT,
  domain        TEXT,
  tech_stack    TEXT DEFAULT 'react-vite',
  status        TEXT DEFAULT 'imported',  -- imported | deployed | live
  notes         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agency_deploys (
  id           TEXT PRIMARY KEY,
  site_id      TEXT NOT NULL REFERENCES agency_sites(id),
  triggered_by TEXT,
  cf_deploy_id TEXT,
  branch       TEXT DEFAULT 'main',
  status       TEXT DEFAULT 'pending',   -- pending | building | success | failed
  error        TEXT,
  deployed_at  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- ── Seed agency sites ─────────────────────────────────────────────────────────

INSERT OR IGNORE INTO agency_sites (id, name, slug, repo_path, pages_project, domain, tech_stack, status, notes, created_at, updated_at)
VALUES
  (
    'site-yope-consultancy',
    'Yope Consultancy',
    'yope-consultancy',
    'sites/yope-consultancy',
    'yope-consultancy',
    'yopeconsultancy.com',
    'react-vite-express',
    'imported',
    'Business formation + credit intake forms. ChatbotModal, CreditIntakeModal, FormationIntakeModal. Express server with email sending (email.ts). Run: npm install && npm run build, then: npx wrangler pages deploy ./dist --project-name yope-consultancy',
    datetime('now'), datetime('now')
  ),
  (
    'site-synergy-landing',
    'Synergy Landing',
    'synergy-landing',
    'sites/synergy-landing',
    'synergy-landing',
    NULL,
    'react-vite-express',
    'imported',
    'Deal pipeline, equity thermometer, audience routing, bot chat system. Has pre-built dist/ folder. Deploy immediately: npx wrangler pages deploy ./dist --project-name synergy-landing',
    datetime('now'), datetime('now')
  );

-- ── Agency deploy + build tasks ───────────────────────────────────────────────

INSERT INTO tasks (id, kind, status, assigned_agent_id, team_id, input, telegram_chat_id, scheduled_for, created_at, updated_at)
VALUES
  (
    'task-deploy-synergy-001',
    'research', 'pending', 'agent-research-lead', 'team-research',
    json_object(
      'summary', 'Deploy Synergy Landing to Cloudflare Pages',
      'details', 'The Synergy Landing site has been imported to sites/synergy-landing in bot-nation. It has a pre-built dist/ folder — ready to deploy now. Command: cd sites/synergy-landing && npx wrangler pages deploy ./dist --project-name synergy-landing. After deploy, report the Pages URL (*.pages.dev) and confirm success. Custom domain can be added in Cloudflare Pages dashboard after deploy.'
    ),
    NULL, '2026-04-17 18:00:00', datetime('now'), datetime('now')
  ),
  (
    'task-build-yope-001',
    'research', 'pending', 'agent-research-lead', 'team-research',
    json_object(
      'summary', 'Build and deploy Yope Consultancy to Cloudflare Pages',
      'details', 'The Yope Consultancy site has been imported to sites/yope-consultancy. Steps: (1) cd sites/yope-consultancy && npm install && npm run build. (2) npx wrangler pages deploy ./dist --project-name yope-consultancy. (3) Report the Pages URL. Note: the Express server (email.ts) handles form submissions — for production, migrate email sending to Cloudflare Email Workers. For now, deploy the static frontend. Domain: yopeconsultancy.com — DNS instructions are in the site wrangler.toml.'
    ),
    NULL, '2026-04-17 18:03:00', datetime('now'), datetime('now')
  );
