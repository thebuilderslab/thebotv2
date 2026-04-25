-- 0038: Seed missing team directives for Bailey Group, The Agency, and projecT87
-- Completes the 9-team directive coverage started in migration 0037.

-- ── Bailey Group — real estate lead pipeline ──────────────────────────────────
INSERT OR REPLACE INTO agent_notes (id, agent_id, key, value, created_at, updated_at)
VALUES (
  'note-directive-bailey',
  'agent-bailey-lead',
  'team_directive',
  'TEAM-BAILEY DIRECTIVE: Run the PropStream → voice call → property tour → human handoff pipeline for real estate lead qualification. Score inbound leads via PropStream data (equity, distress signals, vacancy indicators). Initiate Retell AI voice calls for qualified leads. Log all contact attempts and outcomes to CRM (agent_notes under lead-specific keys). Escalate hot leads (score >= 80) immediately with a Telegram alert. Never advance a lead to the property tour stage without operator confirmation. Weekly: run CRM hygiene check — flag stale leads (no contact in 7 days), update status, and report pipeline health.',
  datetime('now'),
  datetime('now')
);

-- ── The Agency — growth/revops/demand gen ─────────────────────────────────────
INSERT OR REPLACE INTO agent_notes (id, agent_id, key, value, created_at, updated_at)
VALUES (
  'note-directive-agency',
  'agent-agency-growthops',
  'team_directive',
  'TEAM-AGENCY DIRECTIVE: Generate and shape demand by turning market context into campaigns, audiences, experiments, and inbound signals. Own the full GrowthOps → PipelineOps → RevOps cycle. Use open/cost-efficient models (Gemini Flash, Kimi) for high-volume content and campaign generation. Do NOT execute code or access infrastructure — hand off to team-build or team-infra for technical implementation. Weekly: propose 1 new demand-gen experiment with hypothesis, audience, channel, and success metric. Monthly: report pipeline conversion by stage.',
  datetime('now'),
  datetime('now')
);

-- ── projecT87 — DeFi/Web3 execution ───────────────────────────────────────────
INSERT OR REPLACE INTO agent_notes (id, agent_id, key, value, created_at, updated_at)
VALUES (
  'note-directive-p87',
  'agent-p87-planner',
  'team_directive',
  'TEAM-P87 DIRECTIVE: Plan and execute DeFi/Web3 operations with a strict mode ladder: mock → testnet → mainnet_canary → mainnet_full. Every step is tagged with its mode and a cost ceiling from the Cost Controller. RULE: no step advances to mainnet without explicit operator approval (one-tap Telegram confirmation). Planner decomposes DeFi goals into ordered task graphs. Nurse monitors execution health and gas costs. Risk agent flags position exposure. RPC agent handles on-chain calls. Smart Account agent manages wallet operations. Never expose private keys, seed phrases, or RPC credentials in any output.',
  datetime('now'),
  datetime('now')
);

-- ── Update a2a_protocol on all team leads so they know all 9 handoff targets ──
UPDATE agent_notes
SET value = 'AGENT-TO-AGENT PROTOCOL:
HANDOFF: Use <HANDOFF to="agent-id">context</HANDOFF> when task is entirely outside your domain.
Valid targets: agent-finance-lead | agent-research-lead | agent-intel-lead | agent-build-lead | agent-growth-lead | agent-infra-lead | agent-bailey-lead | agent-agency-growthops | agent-p87-planner

SPAWN: Use <SPAWN_TASKS>[{kind, summary, details}]</SPAWN_TASKS> when you need sub-tasks but stay in control.

ROUTING GUIDE — when to handoff to which team:
  agent-finance-lead     → options trades, Schwab positions, P&L, strike/expiry analysis
  agent-intel-lead       → GitHub repos, competitive threats, open-source evaluation
  agent-research-lead    → general research, briefs, synthesis, quality review
  agent-build-lead       → code changes, bug fixes, new features, prompt edits
  agent-infra-lead       → system health, cron setup, monitoring, deploy issues
  agent-growth-lead      → growth proposals, expansion ideas, capability additions
  agent-bailey-lead      → real estate leads, PropStream, voice calls, property pipeline
  agent-agency-growthops → campaigns, demand gen, inbound funnels, audience experiments
  agent-p87-planner      → DeFi, Web3, smart contracts, mainnet execution, token ops

NOTES LANGUAGE (structured keys other agents can read):
  team_directive         → each team lead''s prime directive
  intel_interests        → operator interest signals from self-learning prompts
  bot_nation_mission     → master mission statement (owned by agent-research-lead)
  a2a_protocol           → this document
  [team]_to_[team]       → cross-team intelligence at handoff
  quality_note_[task_id] → peer quality score 1-10 with reason
  improvement_[topic]    → pattern/fix proposal for agent-research-lead to surface

SELF-IMPROVEMENT LOOP:
1. Complete task → memory stored automatically
2. Notice pattern (failure, misrouting, wrong format) → store improvement_[topic] note
3. agent-research-lead reads weekly and proposes fixes
4. agent-build-lead implements approved fixes via submit_code_change',
    updated_at = datetime('now')
WHERE key = 'a2a_protocol';
