-- 0045: Register projecT87 DeFi endpoints in the tool registry.
-- Read-only endpoints are 'active' (callable). The on-chain borrow is
-- 'pending_review' (EXPERIMENTAL, approval-gated) and must NOT be autonomous.
-- Endpoints point at the bot-nation-api proxy (/api/p87/*), not projecT87 directly.

INSERT OR IGNORE INTO tools (id, name, kind, description, schema, endpoint, status, created_at, updated_at)
VALUES
  (
    'tool-p87-vault-health',
    'p87_vault_health',
    'http_api',
    'projecT87 (DeFi/Arbitrum): read the wallet''s Aave V3 position — health_factor, total_collateral_usd, total_debt_usd, net_worth_usd, available_borrows_usd. Read-only.',
    '{"type":"object","properties":{},"required":[]}',
    'https://bot-nation-api.thejamalshackleford.workers.dev/api/p87/vault/health',
    'active',
    datetime('now'),
    datetime('now')
  ),
  (
    'tool-p87-notifications',
    'p87_notifications',
    'http_api',
    'projecT87 (DeFi/Arbitrum): list recent notifications for the wallet (id, title, message, priority, created_at). Read-only.',
    '{"type":"object","properties":{},"required":[]}',
    'https://bot-nation-api.thejamalshackleford.workers.dev/api/p87/notifications',
    'active',
    datetime('now'),
    datetime('now')
  ),
  (
    'tool-p87-health',
    'p87_health',
    'http_api',
    'projecT87 (DeFi/Arbitrum): service liveness check. Read-only.',
    '{"type":"object","properties":{},"required":[]}',
    'https://bot-nation-api.thejamalshackleford.workers.dev/api/p87/health',
    'active',
    datetime('now'),
    datetime('now')
  ),
  (
    'tool-p87-credit-borrow',
    'p87_credit_borrow',
    'http_api',
    'EXPERIMENTAL — projecT87 on-chain borrow against Aave collateral. APPROVAL-GATED and NON-AUTONOMOUS: the proxy records intent only and never executes on-chain. Do not enable for autonomous/unattended use. amount: >0 and <=10000; asset: DAI|USDC|USDT.',
    '{"type":"object","properties":{"amount":{"type":"number","description":"Amount to borrow (>0, <=10000)","exclusiveMinimum":0,"maximum":10000},"asset":{"type":"string","enum":["DAI","USDC","USDT"],"description":"Asset to borrow"}},"required":["amount","asset"]}',
    'https://bot-nation-api.thejamalshackleford.workers.dev/api/p87/credit/borrow',
    'pending_review',
    datetime('now'),
    datetime('now')
  );
