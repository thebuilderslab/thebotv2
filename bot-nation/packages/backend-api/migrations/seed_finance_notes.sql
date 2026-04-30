INSERT OR REPLACE INTO agent_notes (agent_id, key, value, created_at, updated_at) VALUES (
  'agent-finance-lead',
  'credit_roll_procedure',
  'CREDIT ROLL PROCEDURE - follow exactly for every options recommendation.

WEEKLY TARGETS: 1 day trade per week (0-2 DTE, target $50-200 credit). 1 weekly credit trade (7-21 DTE, target $100+ net credit).

ROLL DECISION TREE:
1. Check current P&L on each short position via schwab_options_chain
2. If position profitable (>50% max profit): close it, book the win
3. If position at loss or near ATM:
   A. Same-chain credit roll: buy back short, sell further OTM same expiry - min $6 net credit
   B. Calendar credit roll: buy back short, sell same strike next week - target $10-40 net debit max
   C. Inversion roll: CALL at loss means sell PUT credit same/next expiry (directional shift)

OUTPUT FORMAT - every trade recommendation must include:
Line 1: ACTION ITEM: [specific trade]
Line 2: Type: CALL rolling into CALL for net credit (or CALL rolling into PUT, PUT rolling into CALL, etc)
Line 3: Limit: $X.XX to $X.XX net credit (always 0.10 range, e.g. $0.82 to $0.92)
Then table: Strike | Exp | Side | Bid | Ask | Limit
Then: Max loss | Breakeven | Credit received

NEVER use market orders. NEVER recommend a debit roll over $40. ALWAYS provide 3 alternatives if primary roll does not meet $6 credit minimum.

USER CONTEXT:
- Holds GOOGL short calls: 340, 345, 365 strike, April 27 expiry (weeklys)
- Strategy: weekly income via short calls, rolling when threatened
- Risk tolerance: defined-risk only, no naked positions beyond current
- Prefers: simple one-line trade type label before full breakdown',
  '2026-04-21T00:00:00Z',
  '2026-04-21T00:00:00Z'
);

INSERT OR REPLACE INTO agent_notes (agent_id, key, value, created_at, updated_at) VALUES (
  'agent-finance-lead',
  'user_trading_profile',
  'USER TRADING PROFILE - Jovan. Weekly options income strategy on GOOGL. Short calls at 340/345/365 (Apr 27 weeklys). Wants 1 day trade and 1 weekly credit trade per week. Defined-risk only. Approves trades via Telegram before execution. Communication style: brief, direct, action-first. Show limit price range (0.10 spread). No market orders ever. Suppress internal agent coordination from result messages.',
  '2026-04-21T00:00:00Z',
  '2026-04-21T00:00:00Z'
);
