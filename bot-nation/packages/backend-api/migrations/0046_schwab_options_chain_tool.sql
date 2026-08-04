-- 0046: Register the missing schwab_options_chain tool row.
-- The CAPABILITY has always been live: POST /api/finance/options → fetchOptionsChain
-- → https://api.schwabapi.com/marketdata/v1/chains. Finance SOP prompts
-- (trigger_briefs.sql, seed_finance_notes.sql) instruct agents to "call
-- schwab_options_chain", but migration 0033 only ran an UPDATE ... WHERE
-- name='schwab_options_chain' that matched 0 rows — the INSERT never existed, so
-- registry-driven tool discovery could not find it. This inserts it with the same
-- schema 0033 intended, pointing at the live endpoint.

INSERT OR IGNORE INTO tools (id, name, kind, description, schema, endpoint, status, created_at, updated_at)
VALUES (
  'tool-schwab-options-chain',
  'schwab_options_chain',
  'http_api',
  'Fetch a live options chain from Schwab Market Data for a symbol (bid/ask/mark per strike+expiry). Use to check current option marks and compute P&L vs entry. Params: symbol (required), contract_type (CALL|PUT|ALL), strike_count, from_date, to_date (YYYY-MM-DD).',
  '{"type":"object","properties":{"symbol":{"type":"string","description":"Ticker symbol e.g. GOOGL, SPY, AAPL"},"contract_type":{"type":"string","enum":["CALL","PUT","ALL"],"description":"CALL, PUT, or ALL (default ALL)"},"strike_count":{"type":"integer","description":"Number of strikes each side of ATM to return (default 10). Use 5 for a quick scan."},"from_date":{"type":"string","description":"Start expiration date YYYY-MM-DD. Set same as to_date to pin one exact expiry."},"to_date":{"type":"string","description":"End expiration date YYYY-MM-DD. Set same as from_date to pin one exact expiry."}},"required":["symbol"]}',
  'https://bot-nation-api.thejamalshackleford.workers.dev/api/finance/options',
  'active',
  datetime('now'),
  datetime('now')
);
