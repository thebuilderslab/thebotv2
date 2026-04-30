-- 0032: Update Finance Dept objectives to reflect Schwab trading mission
-- Replaces stale "token cost tracking" objective with actual live-trading mandate

UPDATE teams
SET objectives = 'Trade US equities and options via Schwab. Produce pre-market briefs (8:30 AM), midday updates (12 PM), and EOD reports (4:30 PM ET). Monitor open positions against stop-loss and profit targets — stage close orders automatically when triggered. Produce weekly entry/exit trade plans every Sunday. All analysis scoped to live Schwab positions only.'
WHERE id = 'team-finance';

UPDATE agents
SET objectives = 'Lead the Finance Dept. Execute morning pre-market brief, midday check-in, and EOD summary. Load live Schwab positions at the start of every task. Identify day-trade setups and weekly credit spreads on held symbols. Stage ##TRADE_ORDER## blocks for operator approval. Enforce stop-loss and profit-target rules on every options position.'
WHERE id = 'agent-finance-lead';

UPDATE agents
SET objectives = 'Support finance-lead with deep market research, sector analysis, and options flow data. Pull Schwab account data on request. Flag unusual volume or IV spikes on held underlyings. Cross-reference 30-day trend data for position management decisions.'
WHERE id = 'agent-finance-analyst';
