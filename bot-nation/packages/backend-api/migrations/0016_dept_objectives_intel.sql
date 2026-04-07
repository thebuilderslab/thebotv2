-- Phase 9A: Department objectives, Intel dept, Tavily todo, voice note support
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add objectives column to teams and agents
ALTER TABLE teams  ADD COLUMN objectives TEXT;
ALTER TABLE agents ADD COLUMN objectives TEXT;

-- 2. Set team objectives
UPDATE teams SET objectives = 'Monitor AI, DeFi, and open-source tooling developments. Produce weekly intelligence briefs. Evaluate new frameworks for nation integration. Flag repos with high adoption potential.' WHERE id = 'team-research';
UPDATE teams SET objectives = 'Generate qualified leads, maintain pipeline health, create campaign content, enforce CRM hygiene. Target: 3 new qualified leads per week. Track conversion rates.' WHERE id = 'team-agency';
UPDATE teams SET objectives = 'Monitor Aave V3 positions on Arbitrum. Execute approved DeFi strategies. Flag health factors below 1.5 immediately. Produce daily position reports.' WHERE id = 'team-p87';
UPDATE teams SET objectives = 'Ship 1 infrastructure improvement per sprint. Maintain code quality. Implement approved proposals. Review and test all system changes before deployment.' WHERE id = 'team-build';
UPDATE teams SET objectives = 'Track token usage and API costs daily. Optimize model spend. Flag cost anomalies. Produce weekly cost reports with recommendations.' WHERE id = 'team-finance';
UPDATE teams SET objectives = 'Review submitted GitHub and social links for safety and value. Assess repos for nation infrastructure improvements. Propose new departments for high-value tools.' WHERE id = 'team-growth';

-- 3. Set Nation Supervisor objectives
UPDATE agents SET objectives = 'Coordinate all departments. Route tasks to correct teams. Monitor system health. Review proposals. Respond to Telegram voice notes and text commands. Maintain nation-wide context.' WHERE id = 'agent-nation-supervisor';

-- 4. Intel department (Repo Review)
INSERT OR IGNORE INTO teams (id, name, domain, lead_agent_id, member_ids, policies, created_at, updated_at, objectives)
VALUES (
  'team-intel',
  'Intel Team',
  'knowledge',
  'agent-intel-lead',
  '["agent-intel-lead","agent-intel-researcher","agent-intel-assessor"]',
  '{"maxRiskTier":"medium","requiresHumanApproval":false,"blockedCapabilities":[]}',
  datetime('now'), datetime('now'),
  'Review submitted GitHub repos and social links. Verify authenticity using ossinsight.io and GitHub API. Assess safety, value-add, and infrastructure fit. Propose new departments for tools worth adopting.'
);

INSERT OR IGNORE INTO agents (id, name, role, domain, team_id, status, permissions, traits, capabilities, description, objectives, created_at, updated_at)
VALUES (
  'agent-intel-lead',
  'Intel Lead',
  'team_lead',
  'knowledge',
  'team-intel',
  'active',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  '{"analytical":true,"thorough":true,"skeptical":true}',
  '["repo_review","safety_assessment","value_analysis","proposal_generation"]',
  'Leads the Intel Team. Coordinates repo review pipeline. Synthesises safety and value assessments into final recommendations.',
  'Review every submitted link. Produce structured assessments: Safe/Unsafe, Value/Redundant/Adopt. If Adopt, generate a department proposal.',
  datetime('now'), datetime('now')
),
(
  'agent-intel-researcher',
  'Repo Researcher',
  'researcher',
  'knowledge',
  'team-intel',
  'active',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  '{"curious":true,"methodical":true}',
  '["github_api","ossinsight_api","web_search","readme_analysis"]',
  'Deep-dives into repos: stars, contributors, commit velocity, license, dependencies, README quality, real-world adoption.',
  'Fetch repo metadata from GitHub API and ossinsight.io. Summarise health, activity, and community size accurately.',
  datetime('now'), datetime('now')
),
(
  'agent-intel-assessor',
  'Value Assessor',
  'analyst',
  'knowledge',
  'team-intel',
  'active',
  '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}',
  '{"critical":true,"pragmatic":true}',
  '["value_analysis","redundancy_check","safety_review","infrastructure_mapping"]',
  'Determines if a repo improves nation infrastructure, is redundant, or adds no value. Maps tool capabilities to existing agent gaps.',
  'For each repo: (1) Is it safe? (2) Does it improve reasoning/logic/workflow/performance? (3) Is it redundant? (4) Recommend: Adopt/Monitor/Ignore.',
  datetime('now'), datetime('now')
);

-- 5. Intel tools: GitHub API + OSSInsight
INSERT OR IGNORE INTO tools (id, name, kind, description, schema, endpoint, status, created_at, updated_at)
VALUES
(
  'tool-github-repo',
  'github_repo_info',
  'http_get',
  'Fetch GitHub repository metadata: stars, forks, language, license, open issues, last commit, description. Input: { owner: string, repo: string }',
  '{"type":"object","properties":{"owner":{"type":"string","description":"GitHub username or org"},"repo":{"type":"string","description":"Repository name"}},"required":["owner","repo"]}',
  'https://api.github.com/repos',
  'active',
  datetime('now'), datetime('now')
),
(
  'tool-ossinsight-repo',
  'ossinsight_repo',
  'http_get',
  'Fetch OSS Insight analytics for a GitHub repo: contributor count, star history, PR velocity, geographic distribution. Input: { owner: string, repo: string }',
  '{"type":"object","properties":{"owner":{"type":"string"},"repo":{"type":"string"}},"required":["owner","repo"]}',
  'https://api.ossinsight.io/v1/repos',
  'active',
  datetime('now'), datetime('now')
);

-- 6. Intel review graph
INSERT OR IGNORE INTO agent_graphs (id, agent_id, name, description, definition, created_at, updated_at)
VALUES (
  'graph-intel-review',
  'agent-intel-lead',
  'Repo Intelligence Review',
  'Classify link → fetch repo data → safety check → value assessment → final report with recommendation',
  '{
    "startNode": "fetch_repo",
    "nodes": [
      {
        "id": "fetch_repo",
        "kind": "tool_call",
        "toolName": "github_repo_info",
        "label": "Fetch GitHub Repo"
      },
      {
        "id": "fetch_ossinsight",
        "kind": "tool_call",
        "toolName": "ossinsight_repo",
        "label": "Fetch OSSInsight Stats"
      },
      {
        "id": "web_context",
        "kind": "tool_call",
        "toolName": "web_search",
        "label": "Search Web Context"
      },
      {
        "id": "safety_check",
        "kind": "llm_call",
        "label": "Safety Assessment",
        "model": "google/gemini-2.5-flash",
        "prompt": "You are a security analyst reviewing an open-source repository for a production AI system.\n\nRepo data: {{prev}}\n\nAssess:\n1. LICENSE — is it permissive (MIT/Apache) or restrictive (GPL/AGPL/proprietary)?\n2. MAINTAINERS — active and reputable, or abandoned?\n3. DEPENDENCIES — any known malicious or suspicious packages?\n4. HISTORY — any security incidents, supply chain attacks, or controversial changes?\n5. RED FLAGS — unusual scripts, obfuscated code, data exfiltration patterns?\n\nOutput: SAFE or UNSAFE, followed by a 2-3 sentence justification."
      },
      {
        "id": "value_assess",
        "kind": "llm_call",
        "label": "Value Assessment",
        "model": "google/gemini-2.5-flash",
        "prompt": "You are an AI infrastructure architect evaluating if this repo improves Bot Nation.\n\nBot Nation is a governed multi-agent OS on Cloudflare Workers + D1 + Durable Objects. It has departments for: Research, Build, Finance, Agency (sales/growth), projecT87 (DeFi), Intel.\n\nRepo data and safety check: {{prev}}\n\nOriginal link submitted: {{task}}\n\nEvaluate:\n1. Does this improve REASONING or LOGIC in the system?\n2. Does this improve WORKFLOW or ORCHESTRATION?\n3. Does this improve PERFORMANCE or COST?\n4. Does this add a NEW CAPABILITY not currently in the nation?\n5. Is it REDUNDANT with existing tools (SearXNG, OpenRouter, Cloudflare DO, D1)?\n\nOutput one of: ADOPT | MONITOR | IGNORE\nThen explain in 3-4 sentences what specific department or agent would benefit."
      },
      {
        "id": "final_report",
        "kind": "llm_call",
        "label": "Final Intel Report",
        "model": "google/gemini-2.5-flash",
        "prompt": "Write a structured Intel Report for this repository submission.\n\nAll assessments: {{prev}}\nOriginal submission: {{task}}\n\nFormat exactly as:\n## Intel Report\n**Repo:** [name]\n**URL:** [url]\n**Stars:** [n] | **License:** [type] | **Last Commit:** [date]\n\n### Safety: SAFE / UNSAFE\n[1-2 sentences]\n\n### Value: ADOPT / MONITOR / IGNORE\n[2-3 sentences on which dept benefits and why]\n\n### Recommendation\n[1 clear action: adopt into X dept | monitor for Y months | ignore because Z]\n\n### If ADOPT: Proposed Department\n**Name:** [dept name]\n**Purpose:** [one sentence]\n**Key Agents:** [2-3 agent roles]\n**Integrates with:** [existing nation components]"
      },
      {
        "id": "end",
        "kind": "end",
        "label": "Done"
      }
    ],
    "edges": [
      { "from": "fetch_repo",       "to": "fetch_ossinsight", "condition": "on_success" },
      { "from": "fetch_repo",       "to": "web_context",      "condition": "on_failure" },
      { "from": "fetch_ossinsight", "to": "safety_check",     "condition": "always" },
      { "from": "web_context",      "to": "safety_check",     "condition": "always" },
      { "from": "safety_check",     "to": "value_assess",     "condition": "always" },
      { "from": "value_assess",     "to": "final_report",     "condition": "always" },
      { "from": "final_report",     "to": "end",              "condition": "always" }
    ]
  }',
  datetime('now'), datetime('now')
);

-- 7. Nation Coordinator Tavily todo task
INSERT OR IGNORE INTO tasks (id, kind, status, assigned_agent_id, team_id, input, spawn_depth, created_at, updated_at)
VALUES (
  'task-tavily-research-todo',
  'research',
  'pending',
  'agent-nation-supervisor',
  'team-research',
  '{"summary":"Research Tavily API as search backend for Bot Nation. Evaluate: free tier limits (1000 searches/month), response quality vs SearXNG, integration complexity, pricing for scale. Compare to current SearXNG setup. Recommend adoption timeline.","source":"nation_coordinator_todo"}',
  0,
  datetime('now'), datetime('now')
);
