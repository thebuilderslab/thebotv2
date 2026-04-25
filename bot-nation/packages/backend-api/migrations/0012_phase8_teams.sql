-- Phase 8: The Agency + projecT87 department seeding
-- Maps both external team specs into Bot Nation OS agents + teams.
-- claude-code patterns: Observability/RevOps agents only (per handoff spec).

-- ═══════════════════════════════════════════════════════════════════
-- THE AGENCY — Sales & Growth Department
-- ═══════════════════════════════════════════════════════════════════

-- GrowthOps Head — demand creation, multilingual campaigns, ICP research
INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-agency-growthops',
  'GrowthOps Head',
  'team_lead',
  'execution_growth',
  'Generates and shapes demand by turning market context into campaigns, audiences, experiments, and inbound signals. Uses open/cost-efficient models for high-volume multilingual content work. Does NOT need code execution rights.',
  '["market_research","icp_segmentation","offer_positioning","multilingual_localization","campaign_generation","experiment_analysis"]',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active', datetime('now'), datetime('now')
);

-- PipelineOps Head — outbound, qualification, meeting booking
INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-agency-pipelineops',
  'PipelineOps Head',
  'team_lead',
  'execution_growth',
  'Turns demand into qualified conversations and booked meetings. Owns prospecting, enrichment, sequence management, objection handling, and CRM lead-state progression. Tightly guarded due to consent and brand risk.',
  '["prospecting_enrichment","sequence_management","lead_qualification","objection_handling","call_summary","compliance_consent"]',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active', datetime('now'), datetime('now')
);

-- RevOps Head — CRM hygiene, workflow automation, reporting (gets claude-code patterns)
INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-agency-revops',
  'RevOps Head',
  'team_lead',
  'execution_product',
  'Keeps the commercial system operationally clean and measurable. Owns CRM integrity, workflow routing, document assembly, reporting, and pipeline audits. Has repo-aware automation rights for workflow templates and dashboard scripts.',
  '["crm_hygiene","workflow_routing","document_assembly","reporting_kpi","pipeline_audit","conversion_attribution","content_generation"]',
  '{"canWriteCode":true,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active', datetime('now'), datetime('now')
);

-- Guardrail & Auth Head — pre-action authorization for all Agency actions
INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-agency-guardrail',
  'Agency Guardrail Head',
  'specialist',
  'governance',
  'Enforces action-level safety for The Agency. Applies pre-action authorization to outbound sends, bulk CRM edits, document generation, and paid actions. Logs all policy denials as first-class events.',
  '["authorization_gate","budget_check","policy_check","safety_filter","human_review_escalation"]',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active', datetime('now'), datetime('now')
);

-- Observability & Eval Head — log schema, replay, evals (gets claude-code patterns)
INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-agency-observability',
  'Agency Observability Head',
  'specialist',
  'governance',
  'Makes every commercial run inspectable and improvable. Owns canonical log schema, reply/meeting/qualification rate tracking, run replay, and eval feedback into skill refinement. Has repo-aware access for schema and eval dataset management.',
  '["observability_hook","logging_eval","scorecard_generation","failure_cluster_analysis","prompt_refinement"]',
  '{"canWriteCode":true,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active', datetime('now'), datetime('now')
);

-- The Agency team record
INSERT OR IGNORE INTO teams (id, name, domain, lead_agent_id, member_ids, policies, created_at, updated_at)
VALUES (
  'team-agency',
  'The Agency',
  'execution_growth',
  'agent-agency-growthops',
  '["agent-agency-growthops","agent-agency-pipelineops","agent-agency-revops","agent-agency-guardrail","agent-agency-observability"]',
  '{"maxRiskTier":"medium","requiresHumanApproval":true,"blockedCapabilities":[],"environments":["draft","internal_review","client_review","sandbox_live","production_live"]}',
  datetime('now'), datetime('now')
);

-- Agency agent memory — routing rules and environment ladder
INSERT OR IGNORE INTO agent_notes (id, agent_id, key, value, created_at, updated_at)
VALUES (
  'note-agency-routing',
  'agent-agency-growthops',
  'department_routing',
  'GrowthOps→campaigns/research | PipelineOps→outbound/qualification | RevOps→CRM/reporting | Guardrail checks ALL actions before execution | Observability logs ALL decisions',
  datetime('now'), datetime('now')
);

INSERT OR IGNORE INTO agent_notes (id, agent_id, key, value, created_at, updated_at)
VALUES (
  'note-agency-envladder',
  'agent-agency-guardrail',
  'environment_ladder',
  'draft→internal_review→client_review→sandbox_live→production_live. No high-impact tool path skips stages. Mass outreach requires production_live + human approval.',
  datetime('now'), datetime('now')
);

-- ═══════════════════════════════════════════════════════════════════
-- projecT87 — DeFi Bot Department (Arbitrum + Aave)
-- ═══════════════════════════════════════════════════════════════════

-- Planner Head — DAG task graph builder, cost-aware workflow orchestration
INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-p87-planner',
  'p87 Planner Head',
  'team_lead',
  'execution_product',
  'Turns user or system DeFi goals into ordered, cost-aware task graphs. Tags each step with mode (mock/testnet/mainnet_canary/mainnet_full) and attaches cost ceilings from Cost Controller. Enforces human approval before any mainnet step runs.',
  '["task_routing","intent_classification","workflow_planning","approval_gate","budget_tagging"]',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active', datetime('now'), datetime('now')
);

-- Protocol Execution Head — Aave adapter calls (quote→simulate→build→submit→confirm)
INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-p87-execution',
  'p87 Execution Head',
  'specialist',
  'execution_infra',
  'Safely turns approved DeFi plans into on-chain transactions. Owns Aave adapter calls: deposit/withdraw, borrow/repay, rate mode changes, swaps. Calls Quote→Simulate→Build→Submit→Confirm pipeline. Aborts when Risk/Policy constraints are violated.',
  '["aave_deposit","aave_withdraw","aave_borrow","aave_repay","swap_routing","tx_simulation","receipt_reporting"]',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":true,"canAutoDeploy":false}',
  'active', datetime('now'), datetime('now')
);

-- Smart Account Head — ZeroDev session keys, batching, gas sponsorship
INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-p87-smartaccount',
  'p87 Smart Account Head',
  'specialist',
  'execution_infra',
  'Manages ZeroDev smart accounts, session keys scoped to specific contracts, batched transactions, and gas sponsorship. Enforces ZeroDev call/gas/rate-limit policies. Surfaces sponsorship failures as first-class errors.',
  '["zerodev_account_management","session_key_issuance","tx_batching","gas_sponsorship","policy_enforcement"]',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":true,"canAutoDeploy":false}',
  'active', datetime('now'), datetime('now')
);

-- RPC / Infra Head — Alchemy routing, CU budget enforcement
INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-p87-rpc',
  'p87 RPC Head',
  'specialist',
  'execution_infra',
  'Provides reliable Arbitrum RPC via Alchemy while staying within free-tier limits (30M CU/mo, 25 RPS). Routes by mode. Prefers websockets/webhooks over polling. Alerts when CU/RPS near limits.',
  '["rpc_routing","websocket_streaming","webhook_management","cu_tracking","rate_limit_enforcement"]',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active', datetime('now'), datetime('now')
);

-- Risk / Policy Head — portfolio constraints, LTV gates, allowlists
INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-p87-risk',
  'p87 Risk Head',
  'specialist',
  'execution_finance',
  'Encodes portfolio, protocol, and security constraints into machine-readable policies that gate all DeFi execution. Maintains asset allowlists, max LTV targets, slippage caps, and volatility-regime blocks. Provides fast policy-check tool for every execution step.',
  '["policy_check","risk_assessment","ltv_enforcement","slippage_cap","allowlist_management"]',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active', datetime('now'), datetime('now')
);

-- Nurse / Telemetry Head — health factor monitoring, repay triggers, PnL
INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-p87-nurse',
  'p87 Nurse Head',
  'specialist',
  'execution_finance',
  'Continuously monitors all Aave positions: health factor, collateral/debt values, liquidation distances. Triggers repay/delever via Planner when thresholds hit. Owns PnL, risk-adjusted returns, and execution quality telemetry per tenant.',
  '["health_factor_monitoring","repay_trigger","delever_trigger","pnl_tracking","performance_reporting","health_summary"]',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active', datetime('now'), datetime('now')
);

-- Observability Head — canonical log schema, replay, eval (gets claude-code patterns)
INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-p87-observability',
  'p87 Observability Head',
  'specialist',
  'governance',
  'Makes every DeFi run inspectable and debuggable. Defines canonical log schema (run ID, tenant, strategy, plan step, agents, costs, results). Stores all decisions, ZeroDev/Alchemy calls, and position changes. Supports full run replay. Has repo-aware access for schema and eval management.',
  '["log_schema_management","run_replay","failure_cluster_analysis","cost_by_feature","success_rate_tracking"]',
  '{"canWriteCode":true,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active', datetime('now'), datetime('now')
);

-- projecT87 team record
INSERT OR IGNORE INTO teams (id, name, domain, lead_agent_id, member_ids, policies, created_at, updated_at)
VALUES (
  'team-p87',
  'projecT87',
  'execution_finance',
  'agent-p87-planner',
  '["agent-p87-planner","agent-p87-execution","agent-p87-smartaccount","agent-p87-rpc","agent-p87-risk","agent-p87-nurse","agent-p87-observability"]',
  '{"maxRiskTier":"high","requiresHumanApproval":true,"blockedCapabilities":[],"modes":["mock","testnet","mainnet_canary","mainnet_full"],"mainnetRequiresApproval":true}',
  datetime('now'), datetime('now')
);

-- p87 agent memory — critical operating rules
INSERT OR IGNORE INTO agent_notes (id, agent_id, key, value, created_at, updated_at)
VALUES (
  'note-p87-modes',
  'agent-p87-planner',
  'execution_modes',
  'mock→testnet→mainnet_canary→mainnet_full. NEVER skip stages. mainnet_canary and mainnet_full ALWAYS require human approval. Cost Controller budget must be checked before any step.',
  datetime('now'), datetime('now')
);

INSERT OR IGNORE INTO agent_notes (id, agent_id, key, value, created_at, updated_at)
VALUES (
  'note-p87-hardstops',
  'agent-p87-risk',
  'hard_stops',
  'DENY if: health_factor < 1.2 | LTV > max_ltv_policy | asset not in allowlist | slippage > cap | volatility_regime = HIGH and action is new_position | budget exhausted',
  datetime('now'), datetime('now')
);

INSERT OR IGNORE INTO agent_notes (id, agent_id, key, value, created_at, updated_at)
VALUES (
  'note-p87-alchemy',
  'agent-p87-rpc',
  'rate_limits',
  'Alchemy free tier: 30M CU/mo | 25 RPS | 5 apps | 5 webhooks. Use websockets for price streaming. Use webhooks for events instead of getLogs polling. Alert at 80% monthly CU.',
  datetime('now'), datetime('now')
);
