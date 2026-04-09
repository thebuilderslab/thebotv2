-- Phase 5: Bailey Group Real Estate Department
-- Seeds team, 6 agents, sample leads, and initial tasks

-- Insert Bailey Group team
INSERT OR IGNORE INTO teams (id, name, domain, lead_agent_id, created_at, updated_at, objectives)
VALUES (
  'team-bailey',
  'Bailey Group',
  'execution_product',
  'agent-bailey-lead',
  datetime('now'),
  datetime('now'),
  'Automate lead scoring via PropStream. Execute AI voice calls. Route qualified leads to human reps for property tours and offers. Target: 4 leads/day → 2-3 closed deals/month.'
);

-- Insert 6 Bailey agents
INSERT OR IGNORE INTO agents (id, name, role, domain, team_id, description, status, objectives, created_at, updated_at)
VALUES
  ('agent-bailey-lead', 'Bailey Lead', 'team_lead', 'execution_product', 'team-bailey',
   'Orchestrates PropStream automation → voice calls → property tours → human handoff',
   'active',
   'Manage daily lead pipeline. Ensure voice calls execute. Route qualified leads to inspection scheduling. Monitor daily metrics.',
   datetime('now'), datetime('now')),

  ('agent-bailey-propstream', 'PropStream Browser', 'specialist', 'execution_infra', 'team-bailey',
   'Uses Perplexity Computer vision to navigate PropStream, extract lead data, score properties',
   'active',
   'Pull 1-4 properties/day from My Properties. Score using distress+equity+ownership+market factors. Write standard notes block back to PropStream.',
   datetime('now'), datetime('now')),

  ('agent-bailey-scorer', 'Lead Scorer', 'specialist', 'execution_product', 'team-bailey',
   'Applies PropStream data to scoring logic: distress (0-4) + equity (0-3) + ownership (0-3) + market (0-2) = priority score 0-12',
   'active',
   'Generate HOT/WARM/COLD classification. Suggest call angle (timeline, equity, fatigue). Prepare script variables.',
   datetime('now'), datetime('now')),

  ('agent-bailey-voice', 'Niamo Voice Agent', 'specialist', 'execution_product', 'team-bailey',
   'Retell AI voice agent. Delivers Niamo script with natural conversation. Asks about rented units, challenges, property story, off-market interest.',
   'active',
   'Execute 1-4 calls/day. Capture transcripts. Extract key data (rented units, timeline, condition, motivation). Route to disposition.',
   datetime('now'), datetime('now')),

  ('agent-bailey-crm', 'CRM & Scheduling', 'specialist', 'execution_infra', 'team-bailey',
   'Post-call: stores transcript + extracted data. Sends calendar invites for property tours. Notifies human reps.',
   'active',
   'Schedule property tours for qualified leads. Send calendar invites. Prepare inspector briefing. Track disposition status.',
   datetime('now'), datetime('now')),

  ('agent-bailey-observability', 'Daily Reports', 'specialist', 'governance', 'team-bailey',
   'Generates daily metrics: calls completed, qualified leads, tours scheduled, disposition summary, cost analysis.',
   'active',
   'Produce daily report: 4pm each day. Track conversion funnel. Flag anomalies. Recommend optimizations.',
   datetime('now'), datetime('now'));

-- Insert first 3 sample PropStream leads (will be auto-imported from PropStream in production)
INSERT OR IGNORE INTO tasks (id, kind, status, assigned_agent_id, team_id, input, spawn_depth, created_at, updated_at, parent_task_id)
VALUES
  ('lead-001-smith', 'propstream_lead_score', 'pending', 'agent-bailey-lead', 'team-bailey',
   '{"property_address": "412 Maple St, Springfield, IL", "owner": "John Smith", "phone": "(555) 123-4567", "rented_units": 2, "total_units": 3, "occupied_years": 10, "equity_percent": 73, "estimated_value": 525000, "status": "pre_foreclosure"}',
   0, datetime('now'), datetime('now'), NULL),

  ('lead-002-jones', 'propstream_lead_score', 'pending', 'agent-bailey-lead', 'team-bailey',
   '{"property_address": "850 Oak Ave, New Haven, CT", "owner": "Mary Jones", "phone": "(203) 456-7890", "rented_units": 1, "total_units": 2, "occupied_years": 8, "equity_percent": 65, "estimated_value": 385000, "status": "absentee_distressed"}',
   0, datetime('now'), datetime('now'), NULL),

  ('lead-003-williams', 'propstream_lead_score', 'pending', 'agent-bailey-lead', 'team-bailey',
   '{"property_address": "1200 Pine Rd, Stamford, CT", "owner": "Robert Williams", "phone": "(203) 789-0123", "rented_units": 0, "total_units": 1, "occupied_years": 15, "equity_percent": 82, "estimated_value": 450000, "status": "tired_landlord"}',
   0, datetime('now'), datetime('now'), NULL);
