INSERT INTO tasks (id, kind, status, assigned_agent_id, team_id, input, telegram_chat_id, created_at, updated_at)
VALUES (
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
  'research',
  'pending',
  'agent-finance-lead',
  'team-finance',
  '{"summary":"Morning trading analysis","details":"You are agent-finance-lead. Produce the 8:30 AM pre-market brief. Execute ALL steps in order.\n\nSTEP 1 - LOAD YOUR LIVE POSITIONS (do this first)\nCall GET /api/finance/positions to get current Schwab positions.\nBuild: HELD_UNDERLYINGS (unique underlying stock symbols) and HELD_OPTIONS (each option with strike, expiry, type, direction, mark, entry price).\nDo NOT report on any symbol you do not hold.\n\nSTEP 2 - S&P 500 FUTURES (context only, 2-3 lines max)\nFetch /ES=F pre-market via web search. Call GET /api/finance/quotes?symbols=/ES,SPY,QQQ.\nReport: /ES price + % change, sentiment (BULLISH/NEUTRAL/BEARISH), implied SPY open.\n\nSTEP 3 - PRE-MARKET DATA FOR HELD SYMBOLS ONLY\nCall GET /api/finance/quotes?symbols=[HELD_UNDERLYINGS comma-joined].\nFor each: pre-market price + % change, implied open, volume vs average.\n\nSTEP 4 - OPTIONS MARK CHECK\nFor each HELD_OPTIONS position call schwab_options_chain for current bid/ask mark.\nCalculate P&L% vs entry. Apply rules: P&L <= -35% = STOP HIT. P&L >= +180% = TARGET HIT. DTE <= 2 = EXPIRY RISK. Otherwise HOLD.\n\nSTEP 5 - NEWS (held symbols only)\nSearch [symbol] stock news today for each symbol in HELD_UNDERLYINGS only. One line per symbol.\n\nSTEP 6 - 30-DAY TREND (held symbols only)\nFor each held underlying call https://last30days-api.onrender.com or search [symbol] 30 day price trend.\n\nSTEP 7 - DAY TRADE + WEEKLY CREDIT\n1 day trade opportunity (0-2 DTE) and 1 weekly credit trade (7-14 DTE) based only on held symbols.\n\nOUTPUT FORMAT:\n---\n## S&P FUTURES - [BULLISH/NEUTRAL/BEARISH]\n/ES $X,XXX [+/-X.XX%] -> SPY implied open $XXX.XX\n\n## POSITIONS\n**[SYMBOL]** $XXX.XX [+/-X.X% pre-mkt]\nOptions: [strike/expiry/mark/P&L%/decision]\nNews: [one line]\n30d: [trend]\n\n## DAY TRADE WATCH\nDay trade: [setup on held symbol]\nWeekly credit: [setup on held symbol]\n---"}',
  5281111124,
  datetime('now'),
  datetime('now')
);

INSERT INTO tasks (id, kind, status, assigned_agent_id, team_id, input, telegram_chat_id, created_at, updated_at)
VALUES (
  lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1, 1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),
  'content_generation',
  'pending',
  'agent-research-lead',
  'team-research',
  '{"summary":"Daily research digest","details":"Produce today''s research digest. Use web search to find the top 3-5 developments in AI agents, DeFi, and open-source tooling from the last 24 hours. For each item: headline, source, 2-sentence summary, relevance to bot-nation. Format as a concise bullet-point brief suitable for the operator. End with a Bottom Line section: 1-2 sentences on the single most important takeaway for today."}',
  5281111124,
  datetime('now'),
  datetime('now')
);
