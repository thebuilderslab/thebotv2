-- Phase 4: Seed domain teams and lead agents for real execution routing

-- Research Team lead agent
INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-research-lead',
  'Research Lead',
  'team_lead',
  'knowledge',
  'Leads the Research Team. Specializes in gathering, synthesizing, and summarizing information on any topic. Produces structured research reports and knowledge artifacts.',
  '["research","summarization","knowledge_retrieval","report_generation"]',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active',
  datetime('now'),
  datetime('now')
);

-- Build Team lead agent
INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-build-lead',
  'Build Lead',
  'team_lead',
  'execution_product',
  'Leads the Build Team. Plans and coordinates product development work including code changes, feature design, and technical documentation.',
  '["code_review","technical_planning","documentation","content_generation"]',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active',
  datetime('now'),
  datetime('now')
);

-- Infra Team lead agent
INSERT OR IGNORE INTO agents (id, name, role, domain, description, capabilities, permissions, status, created_at, updated_at)
VALUES (
  'agent-infra-lead',
  'Infra Lead',
  'team_lead',
  'execution_infra',
  'Leads the Infra Team. Manages configuration, deployment, and infrastructure-related tasks. Reviews and plans config changes with careful consideration of risk.',
  '["config_review","infrastructure_planning","deployment_coordination","content_generation"]',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  'active',
  datetime('now'),
  datetime('now')
);

-- Research Team
INSERT OR IGNORE INTO teams (id, name, domain, lead_agent_id, member_ids, policies, created_at, updated_at)
VALUES (
  'team-research',
  'Research Team',
  'knowledge',
  'agent-research-lead',
  '["agent-research-lead"]',
  '{"maxRiskTier":"low","requiresHumanApproval":false,"blockedCapabilities":[]}',
  datetime('now'),
  datetime('now')
);

-- Build Team
INSERT OR IGNORE INTO teams (id, name, domain, lead_agent_id, member_ids, policies, created_at, updated_at)
VALUES (
  'team-build',
  'Build Team',
  'execution_product',
  'agent-build-lead',
  '["agent-build-lead"]',
  '{"maxRiskTier":"low","requiresHumanApproval":false,"blockedCapabilities":[]}',
  datetime('now'),
  datetime('now')
);

-- Infra Team
INSERT OR IGNORE INTO teams (id, name, domain, lead_agent_id, member_ids, policies, created_at, updated_at)
VALUES (
  'team-infra',
  'Infra Team',
  'execution_infra',
  'agent-infra-lead',
  '["agent-infra-lead"]',
  '{"maxRiskTier":"low","requiresHumanApproval":false,"blockedCapabilities":[]}',
  datetime('now'),
  datetime('now')
);
