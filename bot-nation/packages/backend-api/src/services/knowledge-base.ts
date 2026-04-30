/**
 * Knowledge Base
 *
 * Internal registry of bot-nation's agents, teams, departments, and architecture.
 * Used by Nation Supervisor to answer infrastructure questions without external queries.
 */

// ============================================================================
// Agent Registry
// ============================================================================

export const AGENTS = {
  'agent-supervisor-001': {
    name: 'Nation Supervisor',
    role: 'Central coordinator and receptionist',
    team: null,
    capabilities: ['Query routing', 'Task creation', 'Status tracking', 'Internal knowledge search'],
    description: 'Main interface agent that receives all Telegram messages, classifies queries, and routes to appropriate teams.',
  },
  'agent-research-lead': {
    name: 'Research Lead',
    role: 'Oversees research and knowledge discovery',
    team: 'team-research',
    capabilities: ['Research execution', 'Information synthesis', 'Fact verification', 'Report generation'],
    description: 'Leads the research team to answer complex questions and gather intelligence.',
  },
  'agent-build-lead': {
    name: 'Build Lead',
    role: 'Oversees product development',
    team: 'team-build',
    capabilities: ['Code generation', 'Architecture design', 'Implementation', 'Testing'],
    description: 'Leads the build team to create features, fix bugs, and improve systems.',
  },
  'agent-infra-lead': {
    name: 'Infra Lead',
    role: 'Oversees infrastructure and operations',
    team: 'team-infra',
    capabilities: ['System configuration', 'Deployment', 'Monitoring', 'Performance optimization'],
    description: 'Leads the infra team to maintain and optimize system infrastructure.',
  },
  'agent-finance-lead': {
    name: 'Finance Lead',
    role: 'Oversees financial analysis and planning',
    team: 'team-finance',
    capabilities: ['Wallet simulation', 'Financial planning', 'Risk analysis', 'Report generation'],
    description: 'Leads the finance team to analyze financial scenarios and provide insights.',
  },
  'agent-growth-lead': {
    name: 'Growth Lead',
    role: 'Oversees marketing and growth',
    team: 'team-growth',
    capabilities: ['Content generation', 'Campaign planning', 'Market analysis', 'Growth strategy'],
    description: 'Leads the growth team to create content and drive user acquisition.',
  },
  'agent-intel-lead': {
    name: 'Intel Lead',
    role: 'Oversees competitive intelligence and repository analysis',
    team: 'team-intel',
    capabilities: ['Repository review', 'Link analysis', 'Competitive research', 'Trend analysis'],
    description: 'Leads the intel team to analyze external sources and provide competitive insights.',
  },
  'agent-bailey-voice': {
    name: 'Naomi (Bailey Voice Agent)',
    role: 'Outbound sales caller for Bailey Group real estate',
    team: 'team-bailey',
    capabilities: ['Outbound calls', 'Skip-traced lead dialing', 'Property inquiry', 'Call disposition logging', 'Script execution'],
    description: 'AI voice agent that calls property owners from skip-traced lead lists. Handles call openers, objection handling, and disposition recording.',
  },
  'agent-bailey-operations': {
    name: 'Bailey Operations',
    role: 'Operations coordinator for Bailey Group',
    team: 'team-bailey',
    capabilities: ['Call scheduling', 'Lead list management', 'Daily report generation', 'CSV processing', 'CRM updates'],
    description: 'Manages call schedules, processes lead CSV uploads, generates daily call reports with transcripts and dispositions.',
  },
  'agent-lead-scorer': {
    name: 'Lead Scorer',
    role: 'Scores and qualifies real estate leads',
    team: 'team-bailey',
    capabilities: ['Lead scoring', 'Property valuation', 'Motivation assessment', 'Priority ranking'],
    description: 'Analyzes skip-traced leads to score motivation level, property value, and call priority.',
  },
  'agent-p87-planner': {
    name: 'P87 Planner',
    role: 'DeFi strategy planning for Project87',
    team: 'team-p87',
    capabilities: ['DeFi strategy', 'Yield optimization', 'Protocol analysis', 'Portfolio planning'],
    description: 'Plans DeFi strategies and yield optimization for Project87 portfolio.',
  },
  'agent-p87-risk': {
    name: 'P87 Risk Analyst',
    role: 'DeFi risk assessment for Project87',
    team: 'team-p87',
    capabilities: ['Risk assessment', 'Smart contract audit review', 'Liquidation monitoring', 'Exposure analysis'],
    description: 'Analyzes risk exposure, monitors liquidation thresholds, and reviews smart contract audits.',
  },
  'agent-p87-nurse': {
    name: 'P87 Health Monitor',
    role: 'Portfolio health monitoring for Project87',
    team: 'team-p87',
    capabilities: ['Health monitoring', 'Alert generation', 'Position tracking', 'Rebalancing recommendations'],
    description: 'Continuously monitors DeFi portfolio health and generates alerts for position changes.',
  },
  'agent-agency-growthops': {
    name: 'Agency GrowthOps',
    role: 'Marketing and campaign execution for The Agency',
    team: 'team-agency',
    capabilities: ['Campaign generation', 'Market research', 'Audience targeting', 'Content strategy'],
    description: 'Executes growth campaigns, conducts market research, and drives audience acquisition for The Agency.',
  },
  'agent-agency-pipelineops': {
    name: 'Agency PipelineOps',
    role: 'Sales pipeline management for The Agency',
    team: 'team-agency',
    capabilities: ['Lead qualification', 'Pipeline management', 'Sales forecasting', 'CRM hygiene'],
    description: 'Manages sales pipeline, qualifies leads, and maintains CRM data quality.',
  },
  'agent-agency-revops': {
    name: 'Agency RevOps',
    role: 'Revenue operations for The Agency',
    team: 'team-agency',
    capabilities: ['CRM hygiene', 'Revenue tracking', 'Data cleanup', 'Reporting'],
    description: 'Handles revenue operations, CRM data hygiene, and financial reporting.',
  },
};

// ============================================================================
// Team Registry
// ============================================================================

export const TEAMS = {
  'team-research': {
    name: 'Research Team',
    domain: 'knowledge',
    lead: 'agent-research-lead',
    members: ['agent-research-lead'],
    description: 'Specializes in research tasks, knowledge discovery, and information synthesis.',
  },
  'team-build': {
    name: 'Build Team',
    domain: 'execution_product',
    lead: 'agent-build-lead',
    members: ['agent-build-lead'],
    description: 'Specializes in product development, coding, and feature implementation.',
  },
  'team-infra': {
    name: 'Infra Team',
    domain: 'execution_infra',
    lead: 'agent-infra-lead',
    members: ['agent-infra-lead'],
    description: 'Specializes in infrastructure, deployment, and system operations.',
  },
  'team-finance': {
    name: 'Finance Team',
    domain: 'execution_finance',
    lead: 'agent-finance-lead',
    members: ['agent-finance-lead'],
    description: 'Specializes in financial analysis, wallet simulation, and economic modeling.',
  },
  'team-growth': {
    name: 'Growth Team',
    domain: 'execution_growth',
    lead: 'agent-growth-lead',
    members: ['agent-growth-lead'],
    description: 'Specializes in marketing, content creation, and user growth strategies.',
  },
  'team-intel': {
    name: 'Intel Team',
    domain: 'intelligence',
    lead: 'agent-intel-lead',
    members: ['agent-intel-lead'],
    description: 'Specializes in competitive intelligence, repository analysis, and trend research.',
  },
  'team-bailey': {
    name: 'Bailey Group',
    domain: 'real_estate_sales',
    lead: 'agent-bailey-operations',
    members: ['agent-bailey-voice', 'agent-bailey-operations', 'agent-lead-scorer'],
    description: 'Real estate sales team handling outbound calling campaigns. Naomi (voice agent) calls skip-traced property owners, operations manages schedules and reports, lead scorer qualifies and prioritizes leads.',
  },
  'team-p87': {
    name: 'Project87 Team',
    domain: 'defi_finance',
    lead: 'agent-p87-planner',
    members: ['agent-p87-planner', 'agent-p87-risk', 'agent-p87-nurse'],
    description: 'DeFi portfolio management team. Plans yield strategies, assesses risk exposure, and monitors portfolio health across protocols.',
  },
  'team-agency': {
    name: 'The Agency',
    domain: 'sales_marketing',
    lead: 'agent-agency-growthops',
    members: ['agent-agency-growthops', 'agent-agency-pipelineops', 'agent-agency-revops'],
    description: 'Sales and marketing operations team. Handles campaigns, pipeline management, lead qualification, and revenue operations.',
  },
};

// ============================================================================
// Department Registry
// ============================================================================

export const DEPARTMENTS = {
  'dept-execution': {
    name: 'Execution Department',
    description: 'Handles all operational execution and implementation',
    teams: ['team-build', 'team-infra', 'team-finance', 'team-growth'],
  },
  'dept-intelligence': {
    name: 'Intelligence Department',
    description: 'Handles research, analysis, and information gathering',
    teams: ['team-research', 'team-intel'],
  },
  'dept-coordination': {
    name: 'Coordination Department',
    description: 'Central coordination and task routing',
    teams: [],
    lead: 'agent-supervisor-001',
  },
  'dept-real-estate': {
    name: 'Real Estate Department',
    description: 'Handles Bailey Group real estate sales operations including outbound calling, lead qualification, and property acquisition',
    teams: ['team-bailey'],
  },
  'dept-defi': {
    name: 'DeFi Department',
    description: 'Handles Project87 decentralized finance operations including yield strategies, risk management, and portfolio monitoring',
    teams: ['team-p87'],
  },
  'dept-sales': {
    name: 'Sales & Marketing Department',
    description: 'Handles The Agency sales pipeline, marketing campaigns, and revenue operations',
    teams: ['team-agency'],
  },
};

// ============================================================================
// Architecture Overview
// ============================================================================

export const ARCHITECTURE = {
  platform: 'Cloudflare Workers',
  components: {
    'api-layer': 'Hono HTTP framework handling REST endpoints',
    'database': 'D1 SQLite for persistent data storage',
    'durable-objects': 'Stateful agents and task execution',
    'telegram-integration': 'Webhook-based message handling',
    'ai-binding': 'Claude LLM for query processing and decision making',
  },
  deployment: 'bot-nation-api.thejamalshackleford.workers.dev',
  databases: {
    'pbot-nation-db': 'Main database for tasks, agents, teams, and knowledge',
  },
};

// ============================================================================
// Skills Registry
// ============================================================================

export const SKILLS = {
  'last30days-research': {
    name: 'Last 30 Days Research Skill',
    description: 'Searches and analyzes information from the last 30 days',
    agents: ['agent-research-lead', 'agent-supervisor-001'],
    capability: 'Recent trend and news analysis',
    repo: 'https://github.com/mvanhorn/last30days-skill',
    installed: false,
    status: 'Planned — not yet installed',
  },
  'hermes-self-improvement': {
    name: 'Hermes Self-Improvement Skill',
    description: 'Enables agents to identify and implement self-improvement strategies through feedback loops and performance analysis',
    agents: ['agent-supervisor-001', 'agent-research-lead'],
    capability: 'Continuous learning and optimization',
    repo: 'https://github.com/NousResearch/hermes-agent',
    installed: false,
    status: 'Planned — not yet installed. Only a skill entry exists, no actual integration.',
  },
  'mirofish-forecasting': {
    name: 'MiroFish Forecasting Skill',
    description: 'Advanced scenario simulation and forecasting capabilities for financial and market predictions',
    agents: ['agent-finance-lead', 'agent-p87-planner', 'agent-p87-risk'],
    capability: 'Financial and trend forecasting',
    repo: 'https://github.com/666ghj/MiroFish',
    installed: false,
    status: 'Planned — not yet installed',
  },
  'outbound-calling': {
    name: 'Outbound Calling Skill',
    description: 'Voice-based outbound calling for sales and lead follow-up. Handles script execution, call disposition, and transcript recording.',
    agents: ['agent-bailey-voice'],
    capability: 'Automated phone calls with AI voice',
    installed: true,
    status: 'Active — used by Bailey Group for property owner outreach',
  },
  'lead-scoring': {
    name: 'Lead Scoring Skill',
    description: 'Scores and qualifies leads based on property data, skip-trace results, and motivation signals.',
    agents: ['agent-lead-scorer', 'agent-agency-pipelineops'],
    capability: 'Lead qualification and priority ranking',
    installed: true,
    status: 'Active — used by Bailey Group and The Agency',
  },
  'llm-query': {
    name: 'LLM Query Skill',
    description: 'Direct query answering via Claude API. Used by Nation Supervisor for simple questions and research tasks.',
    agents: ['agent-supervisor-001', 'agent-research-lead'],
    capability: 'Natural language question answering',
    installed: true,
    status: 'Active — integrated via Anthropic API',
  },
};

// ============================================================================
// Task Types & Routing
// ============================================================================

export const TASK_TYPES = {
  research: {
    name: 'Research',
    description: 'Information gathering and analysis tasks',
    team: 'team-research',
    eta_seconds: 75,
  },
  deep_research: {
    name: 'Deep Research',
    description: 'In-depth investigation and comprehensive analysis',
    team: 'team-research',
    eta_seconds: 120,
  },
  intel_review: {
    name: 'Intelligence Review',
    description: 'Repository and link analysis tasks',
    team: 'team-intel',
    eta_seconds: 120,
  },
  content_generation: {
    name: 'Content Generation',
    description: 'Creating marketing and educational content',
    team: 'team-growth',
    eta_seconds: 45,
  },
  code_change: {
    name: 'Code Change',
    description: 'Implementation and bug fixes',
    team: 'team-build',
    eta_seconds: 60,
  },
  config_change: {
    name: 'Configuration Change',
    description: 'Infrastructure and system configuration updates',
    team: 'team-infra',
    eta_seconds: 45,
  },
  wallet_simulation: {
    name: 'Wallet Simulation',
    description: 'Financial scenario modeling',
    team: 'team-finance',
    eta_seconds: 30,
  },
  market_research: {
    name: 'Market Research',
    description: 'Market analysis and trend research',
    team: 'team-growth',
    eta_seconds: 60,
  },
  lead_qualification: {
    name: 'Lead Qualification',
    description: 'Sales and lead scoring',
    team: 'team-growth',
    eta_seconds: 45,
  },
};

// ============================================================================
// Query Examples (for classification reference)
// ============================================================================

export const QUERY_EXAMPLES = {
  simple_queries: [
    'What is the capital of France?',
    'When was the internet invented?',
    'How does photosynthesis work?',
    'What is cryptocurrency?',
    'Explain machine learning',
  ],
  infrastructure_queries: [
    'What agents do we have?',
    'Which team handles research?',
    'What is agent-research-lead capable of?',
    'What teams exist in bot-nation?',
    'What is our system architecture?',
    'Which agent handles financial analysis?',
    'What is the Research Team domain?',
    'Tell me about bot-nation infrastructure',
  ],
  action_queries: [
    'Call these 5 people',
    'Build a new feature',
    'Research market trends',
    'Create a marketing campaign',
    'Analyze this code',
    'Schedule a meeting',
    'Write documentation',
  ],
};

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get agent details by ID
 */
export function getAgent(agentId: string) {
  return AGENTS[agentId as keyof typeof AGENTS] || null;
}

/**
 * Get team details by ID
 */
export function getTeam(teamId: string) {
  return TEAMS[teamId as keyof typeof TEAMS] || null;
}

/**
 * Get all agents in a team
 */
export function getTeamAgents(teamId: string) {
  const team = getTeam(teamId);
  if (!team) return [];
  return team.members.map((agentId) => getAgent(agentId)).filter(Boolean);
}

/**
 * Get all teams in a department
 */
export function getDepartmentTeams(deptId: string) {
  const dept = DEPARTMENTS[deptId as keyof typeof DEPARTMENTS];
  if (!dept) return [];
  return dept.teams.map((teamId) => getTeam(teamId)).filter(Boolean);
}

/**
 * Format agent info for display
 */
export function formatAgentInfo(agentId: string): string {
  const agent = getAgent(agentId);
  if (!agent) return `Agent ${agentId} not found`;

  return `
**${agent.name}** (${agentId})
Role: ${agent.role}
${agent.team ? `Team: ${getTeam(agent.team)?.name || agent.team}` : 'Team: Central Coordination'}
Capabilities: ${agent.capabilities.join(', ')}
Description: ${agent.description}
  `.trim();
}

/**
 * Format team info for display
 */
export function formatTeamInfo(teamId: string): string {
  const team = getTeam(teamId);
  if (!team) return `Team ${teamId} not found`;

  return `
**${team.name}** (${teamId})
Domain: ${team.domain}
Lead: ${getAgent(team.lead)?.name || team.lead}
Members: ${team.members.length} agent(s)
Description: ${team.description}
  `.trim();
}

/**
 * List all agents
 */
export function listAllAgents(): string {
  return Object.entries(AGENTS)
    .map(([id, agent]) => `• **${agent.name}** (${id}) - ${agent.description}`)
    .join('\n');
}

/**
 * List all teams
 */
export function listAllTeams(): string {
  return Object.entries(TEAMS)
    .map(([id, team]) => `• **${team.name}** (${id}) - ${team.description}`)
    .join('\n');
}
