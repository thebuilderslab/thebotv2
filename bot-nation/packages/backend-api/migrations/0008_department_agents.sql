-- Phase 7B: Full department staffing + Nation Supervisor

-- ── Nation Supervisor ────────────────────────────────────────────────────────
-- The central orchestrator. Owns all Telegram I/O, routes tasks to team leads.
INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-nation-supervisor',
  'Nation Supervisor',
  'supervisor',
  'governance',
  'The central intelligence of Bot Nation. Receives all external commands, classifies intent, routes tasks to the correct team lead, monitors system health, and reports results back to the operator via Telegram. Acts as CEO of the agent nation.',
  '["task_routing","intent_classification","system_monitoring","telegram_comms","proposal_review","agent_coordination"]',
  '{"canWriteCode":false,"canModifyAgents":true,"canTouchWallets":false,"canAutoDeploy":false}',
  'active',
  datetime('now'),
  datetime('now')
);

-- ── Research Team — 2 sub-agents ────────────────────────────────────────────
INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-researcher-1',
  'Deep Researcher',
  'specialist',
  'knowledge',
  'Specialist in deep research. Takes complex topics and produces comprehensive, well-cited research reports. Uses web search to gather current information and synthesizes across multiple sources.',
  '["deep_research","web_search","summarization","fact_checking","report_generation"]',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active',
  datetime('now'),
  datetime('now')
);

INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-researcher-2',
  'Knowledge Curator',
  'specialist',
  'knowledge',
  'Specialist in knowledge curation. Monitors the agent memory store, keeps notes accurate and current, tags and organizes artifacts, and surfaces relevant past research when needed.',
  '["knowledge_retrieval","note_taking","artifact_tagging","memory_curation","summarization"]',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active',
  datetime('now'),
  datetime('now')
);

-- ── Build Team — 2 sub-agents ─────────────────────────────────────────────────
INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-builder-1',
  'Product Engineer',
  'specialist',
  'execution_product',
  'Specialist in product engineering. Designs features, writes technical specs, reviews code architecture, and produces implementation proposals. Focuses on user-facing product quality.',
  '["technical_planning","feature_design","code_review","documentation","improvement_proposal"]',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active',
  datetime('now'),
  datetime('now')
);

INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-builder-2',
  'Content Specialist',
  'specialist',
  'execution_product',
  'Specialist in content generation. Produces blog posts, documentation, changelogs, release notes, and social copy. Works closely with the Growth team to publish content artifacts.',
  '["content_generation","copywriting","documentation","changelog_writing","social_copy"]',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active',
  datetime('now'),
  datetime('now')
);

-- ── Finance Team ──────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-finance-lead',
  'Finance Lead',
  'team_lead',
  'execution_finance',
  'Leads the Finance Team. Oversees treasury simulations, token allocation analysis, budget planning, and financial risk assessments. Never touches live wallets — simulation only.',
  '["wallet_simulation","budget_analysis","treasury_modeling","financial_reporting","risk_assessment"]',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active',
  datetime('now'),
  datetime('now')
);

INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-finance-analyst',
  'Finance Analyst',
  'specialist',
  'execution_finance',
  'Specialist in financial analysis. Models token flows, evaluates protocol economics, produces simulation reports, and flags budget anomalies.',
  '["wallet_simulation","data_analysis","economic_modeling","report_generation"]',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active',
  datetime('now'),
  datetime('now')
);

-- ── Growth Team ────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-growth-lead',
  'Growth Lead',
  'team_lead',
  'execution_growth',
  'Leads the Growth Team. Plans and coordinates community growth initiatives, social media strategy, partnership outreach, and content distribution. Focused on expanding the Bot Nation footprint.',
  '["content_generation","social_strategy","community_management","partnership_research","campaign_planning"]',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active',
  datetime('now'),
  datetime('now')
);

INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-growth-social',
  'Social Agent',
  'specialist',
  'execution_growth',
  'Specialist in social media and community content. Drafts posts, threads, announcements, and engagement copy across Twitter/X, Discord, and Telegram channels.',
  '["content_generation","social_copy","thread_writing","community_engagement","announcement_drafting"]',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active',
  datetime('now'),
  datetime('now')
);

-- ── Finance Team record ────────────────────────────────────────────────────────
INSERT OR IGNORE INTO teams (id, name, domain, lead_agent_id, member_ids, policies, created_at, updated_at)
VALUES (
  'team-finance',
  'Finance Team',
  'execution_finance',
  'agent-finance-lead',
  '["agent-finance-lead","agent-finance-analyst"]',
  '{"maxRiskTier":"medium","requiresHumanApproval":true,"blockedCapabilities":["canTouchWallets"]}',
  datetime('now'),
  datetime('now')
);

-- ── Growth Team record ─────────────────────────────────────────────────────────
INSERT OR IGNORE INTO teams (id, name, domain, lead_agent_id, member_ids, policies, created_at, updated_at)
VALUES (
  'team-growth',
  'Growth Team',
  'execution_growth',
  'agent-growth-lead',
  '["agent-growth-lead","agent-growth-social"]',
  '{"maxRiskTier":"low","requiresHumanApproval":false,"blockedCapabilities":[]}',
  datetime('now'),
  datetime('now')
);

-- ── Update existing team member_ids to include sub-agents ────────────────────
UPDATE teams SET member_ids = '["agent-research-lead","agent-researcher-1","agent-researcher-2"]', updated_at = datetime('now')
WHERE id = 'team-research';

UPDATE teams SET member_ids = '["agent-build-lead","agent-builder-1","agent-builder-2"]', updated_at = datetime('now')
WHERE id = 'team-build';

-- ── Nation Supervisor agent notes (initial memory) ────────────────────────────
INSERT OR IGNORE INTO agent_notes (id, agent_id, key, value, created_at, updated_at)
VALUES (
  'note-supervisor-routing',
  'agent-nation-supervisor',
  'routing_rules',
  'research/deep_research → team-research (agent-research-lead) | code_change/improvement_proposal → team-build (agent-build-lead) | config_change → team-infra (agent-infra-lead) | wallet_simulation → team-finance (agent-finance-lead) | content_generation → team-growth (agent-growth-lead)',
  datetime('now'),
  datetime('now')
);

INSERT OR IGNORE INTO agent_notes (id, agent_id, key, value, created_at, updated_at)
VALUES (
  'note-supervisor-commands',
  'agent-nation-supervisor',
  'telegram_commands',
  '/task <kind> <summary> | /status <taskId> | /approve <proposalId> | /agents | /stats | /help',
  datetime('now'),
  datetime('now')
);
