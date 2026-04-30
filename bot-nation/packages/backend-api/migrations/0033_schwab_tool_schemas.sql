-- 0033: Fix schwab_options_chain schema (was NULL) and add schwab_positions tool
-- Without schema the LLM gets {"type":"object","properties":{}} and doesn't know
-- to pass "symbol", causing 400s that present as "marks unavailable."

-- Fix: add full parameter schema to schwab_options_chain
UPDATE tools
SET schema = '{"type":"object","properties":{"symbol":{"type":"string","description":"Ticker symbol e.g. GOOGL, SPY, AAPL"},"contract_type":{"type":"string","enum":["CALL","PUT","ALL"],"description":"CALL, PUT, or ALL (default ALL)"},"strike_count":{"type":"integer","description":"Number of strikes each side of ATM to return (default 10). Use 5 for a quick scan."},"from_date":{"type":"string","description":"Start expiration date YYYY-MM-DD. Set same as to_date to pin one exact expiry."},"to_date":{"type":"string","description":"End expiration date YYYY-MM-DD. Set same as from_date to pin one exact expiry."}},"required":["symbol"]}'
WHERE name = 'schwab_options_chain';

-- Add: schwab_positions — returns current D1-stored Schwab positions (no params)
INSERT OR IGNORE INTO tools (id, name, kind, description, schema, endpoint, status, created_at, updated_at)
VALUES (
  'tool-schwab-positions',
  'schwab_positions',
  'http_api',
  'Retrieve current Schwab account positions stored in D1 (last sync). Returns: symbol, asset_type, description, quantity, average_price, market_value, unrealized_pnl, account. Call this FIRST in every finance task to build HELD_UNDERLYINGS and HELD_OPTIONS lists.',
  '{"type":"object","properties":{},"required":[]}',
  'https://bot-nation-api.thejamalshackleford.workers.dev/api/finance/positions',
  'active',
  datetime('now'),
  datetime('now')
);
