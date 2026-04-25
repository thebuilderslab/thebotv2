/**
 * Query Classifier
 *
 * Classifies incoming Telegram messages as:
 * 1. SIMPLE - General knowledge questions (answer via LLM)
 * 2. INFRASTRUCTURE - Questions about bot-nation itself (answer from knowledge base)
 * 3. ACTION - Requests to perform work (create task and route)
 */

export type QueryType = 'simple' | 'infrastructure' | 'action';

export interface ClassifiedQuery {
  type: QueryType;
  confidence: number;
  reasoning: string;
  suggestedTeam?: string;
  suggestedTaskKind?: string;
}

// ============================================================================
// Pattern Definitions
// ============================================================================

/**
 * Infrastructure keywords and patterns
 * Questions about bot-nation's structure, agents, teams, capabilities
 */
const INFRASTRUCTURE_PATTERNS = [
  // Agent queries
  /\b(what|which|tell|list|show|who)\b.*\b(agent|agents)\b/i,
  /\bagent[-_]?\w+\b/i, // agent-research-lead, agent_build_lead, etc.

  // Team queries
  /\b(what|which|tell|list|show)\b.*\b(team|teams)\b/i,
  /\bteam[-_]?\w+\b/i,

  // Department/organization
  /\b(department|dept|division|organization|org)\b/i,

  // Capability/skill queries
  /\b(capability|capability|skill|skills|can you|can we|what can)\b.*\b(do|handle|support)\b/i,
  /\b(what can).*(agent|team).*do\b/i,

  // Architecture queries
  /\b(architecture|tech stack|system|infrastructure|infrastructure)\b/i,
  /\bhow.*bot.?nation\b/i,
  /\bbot.?nation\b.*\b(work|function|operate)\b/i,

  // Status/overview queries
  /\b(status|overview|summary|stats|statistics)\b.*\b(system|bot.?nation)\b/i,
  /\b(who|which).*(lead|leads|manager)\b/i,
  /\b(research|build|finance|infra|growth|intel).*(lead|lead agent)\b/i,

  // Domain/team matching
  /\b(research|knowledge)\b.*\b(team|agent|domain)\b/i,
  /\b(build|product|development)\b.*\b(team|agent)\b/i,
  /\b(finance|financial|wallet)\b.*\b(team|agent)\b/i,
  /\b(marketing|growth|content)\b.*\b(team|agent)\b/i,
];

/**
 * Finance / Trading patterns — always route to team-finance as ACTION
 * Covers options, stocks, rolls, positions, strikes, DTE, P/L, signals
 */
const FINANCE_PATTERNS = [
  // Options vocabulary
  /\b(call|put|straddle|strangle|condor|butterfly|spread|diagonal|vertical|credit spread|debit spread)\b/i,
  /\b(roll|rolling|rolled)\b.*\b(up|down|out|forward|strike|position|call|put)\b/i,
  /\b(strike|expir|dte|theta|delta|gamma|vega|iv|implied volatility|greeks)\b/i,
  /\b(ote|otm|itm|atm|at the money|in the money|out of the money)\b/i,
  /\b(open interest|volume|bid.ask|mid price|mark|premium)\b/i,
  /\b(covered call|cash.secured|naked|protective put|collar)\b/i,

  // Position / trade actions
  /\b(examine|should i|should one|stay in|hold|close|exit|entry|enter)\b.*\b(position|trade|call|put|roll|strike)\b/i,
  /\b(roll|rolling)\b.*\b(\d{3}|\d{2,3}[Cc]|\d{2,3}[Pp]|strike|week|expiry|may|apr|jun|jan|feb|mar|jul|aug|sep|oct|nov|dec)\b/i,
  /\b(profit|loss|p&l|p\/l|breakeven|max profit|max loss|risk.reward|credit|debit)\b.*\b(position|trade|call|put|roll|strike|\$)\b/i,
  /\b(\$\d+|collect|generating|earn)\b.*\b(more|profit|credit|premium|per day|theta)\b/i,

  // Stock price / quote lookups — direct price questions always go to finance agent
  /\b(stock price|share price|current price|price of|trading at|what is.*trading|quote for)\b/i,
  /\b(tsla|spy|qqq|spx|ndx|googl|goog|aapl|msft|amzn|nvda|orcl|orcl|meta|nflx|oracle|apple|nvidia|tesla|google|microsoft|amazon)\b.*\b(price|stock|share|trading|worth|value|up|down|gain|loss|percent|%)\b/i,
  /\b(price|stock|share|trading|worth)\b.*\b(tsla|spy|qqq|spx|ndx|googl|goog|aapl|msft|amzn|nvda|orcl|meta|nflx|oracle|apple|nvidia|tesla|google|microsoft|amazon)\b/i,
  /\bwhat.*(stock|share|price|trading|worth|valued|market cap).*\b(tsla|spy|qqq|aapl|msft|amzn|nvda|orcl|meta|nflx|googl|oracle|apple|nvidia|tesla|google|microsoft|amazon)\b/i,

  // Watchlist symbols with trading context
  /\b(tsla|spy|qqq|spx|ndx|googl|goog|aapl|msft|amzn|nvda|orcl|meta|nflx)\b.*\b(call|put|roll|strike|position|trade|analyze|signal|chart|price action)\b/i,
  /\b(market|premarket|after.?hours|open|close|session|intraday|swing|overnight)\b.*\b(signal|setup|analysis|brief|watch|trade|position)\b/i,

  // Technical analysis
  /\b(support|resistance|breakout|breakdown|trend|channel|moving average|rsi|macd|vix|volume spike)\b/i,
  /\b(chart|candlestick|pattern|signal|setup|confluence|momentum|squeeze)\b/i,

  // Portfolio / account
  /\b(portfolio|positions|open position|account|margin|buying power|pnl|unrealized)\b/i,
  /\b(thinkorswim|tos|schwab|td ameritrade|brokerage|order|fill|limit order|market order)\b/i,
];

/**
 * Action keywords and patterns
 * Requests to perform work, create tasks, do something
 */
const ACTION_PATTERNS = [
  // Direct commands
  /\b(call|phone|contact|reach out|email|message)\b/i,
  /\b(build|code|create|develop|write|implement|fix|bug)\b/i,
  /\b(analyze|analyze|review|examine|check|audit)\b/i,
  /\b(generate|create|write|produce|draft|compose)\b/i,
  /\b(research|investigate|look into|find out about)\b/i,
  /\b(schedule|book|arrange|set up|plan|organize)\b/i,

  // Task indicators
  /\b(task|task me|can you|could you|please|would you|help)\b/i,
  /\b(do this|do that|handle this|take care of)\b/i,
  /\b(need.*done|get.*done|complete|accomplish)\b/i,

  // Scope indicators (suggesting significant work)
  /\b(these?|these?\s+\d+|multiple|several|all)\b.*(people|records|items|tasks|calls|emails)\b/i,
  /\b(campaign|strategy|plan|proposal)\b/i,
  /\b(tomorrow|today|this week|next week|urgent|asap)\b/i,

  // Financial/simulation requests
  /\b(simulate|model|forecast|analyze|calculate)\b.*\b(wallet|finance|scenario|market)\b/i,
  /\b(wallet|defi|ethereum|finance|investment)\b.*\b(analyze|simulate|model)\b/i,
];

/**
 * Code change patterns — checked FIRST before any domain (finance, intel, etc.)
 * "fix/change/update/improve/add/remove [anything]" always routes to team-build.
 * The user is asking to modify Bot Nation itself, not perform a finance task.
 */
const CODE_CHANGE_PATTERNS = [
  // Explicit fix/change verbs aimed at bot behaviour, output, or code
  /\b(fix|change|update|modify|improve|refactor|rewrite)\b.{0,60}\b(format|output|display|show|reply|response|message|template|prompt|brief|command|button|route|endpoint|code|script|function|handler|feature)\b/i,
  /\b(make (it|the|this|that))\b.{0,60}\b(show|display|bold|include|exclude|add|remove|format|use|send|return)\b/i,
  /\b(add (a|an|the)|remove (the|a|an))\b.{0,60}\b(feature|button|command|field|column|section|handler|route|endpoint|tool|step|check)\b/i,
  /\b(show|display|format|include|exclude)\b.{0,60}\b(in bold|as bold|with bold|in italic|as a list|as bullets|differently|instead)\b/i,
  // "fix the X to do Y" — explicit repair instruction
  /\bfix\b.{0,40}\bto\b.{0,60}\b(show|display|include|use|send|return|format|output|add|remove)\b/i,
  // "update the X so that / to" — update instruction
  /\b(update|change|modify)\b.{0,40}\b(so (that|it)|to)\b.{0,60}\b(show|include|use|format|output|send|add|remove|display)\b/i,
];

/**
 * Price target queries — handled inline by the /targets command or stored D1 lookup.
 * These are classified as SIMPLE so Nation Supervisor answers from stored data rather
 * than spinning up a full agent task.
 */
const PRICE_TARGET_PATTERNS = [
  /\b(price target|price targets)\b/i,
  /\bshow.*target[s]?\b/i,
  /\bmy target[s]?\b/i,
  /\btargets?\s+for\s+[A-Z]{1,5}\b/i,
  /\bwhat.*target[s]?.*\b(stock|symbol|ticker|[A-Z]{2,5})\b/i,
  /\bdaily target[s]?\b/i,
  /\bweekly target[s]?\b/i,
];

/**
 * Simple query keywords
 * General knowledge, explanations, definitions, facts
 * (These are exclusions - NOT infrastructure, NOT action)
 */
const SIMPLE_QUERY_PATTERNS = [
  // General knowledge
  /\b(what is|what are|define|explain|tell me about|describe)\b/i,
  /\b(how does|how do|how to|how can)\b.*\b(work|function|operate)\b/i,
  /\b(when|where|why|who|which)\b.*(born|created|invented|founded|started)\b/i,

  // Factual/general queries
  /\b(capital of|currency of|population of|size of)\b/i,
  /\b(history of|background of|overview of)\b/i,
  /\b(difference between|comparison|vs)\b/i,

  // Conceptual/educational
  /\b(concept|theory|principle|methodology|framework)\b/i,
  /\b(pros and cons|advantages|disadvantages|benefits|drawbacks)\b/i,
];

// ============================================================================
// Classification Function
// ============================================================================

/**
 * Classify a query into one of three types
 * Returns confidence score (0-1) and reasoning
 */
export function classifyQuery(text: string): ClassifiedQuery {
  const lowerText = text.toLowerCase().trim();

  // ── Code change — checked FIRST, before any domain ──────────────────────────
  // "fix/change/update/improve [anything about bot output/code/format]" always
  // routes to team-build regardless of domain keywords (P&L, brief, etc.).
  const codeChangeScore = checkPatterns(lowerText, CODE_CHANGE_PATTERNS);
  if (codeChangeScore > 0) {
    return {
      type: 'action',
      confidence: Math.max(codeChangeScore, 0.90),
      reasoning: 'Code change request — routed to build team for implementation',
      suggestedTeam: 'team-build',
      suggestedTaskKind: 'code_change',
    };
  }

  // ── Price targets — classify as SIMPLE so Nation Supervisor serves from D1 ──
  // These match before finance patterns because they contain trading keywords
  // but should be answered inline (stored targets) not dispatched to agents.
  const priceTargetScore = checkPatterns(lowerText, PRICE_TARGET_PATTERNS);
  if (priceTargetScore > 0) {
    return {
      type: 'simple',
      confidence: Math.max(priceTargetScore, 0.80),
      reasoning: 'Price target query — served from stored D1 targets by Nation Supervisor',
    };
  }

  // ── Finance/trading — HIGHEST priority, always routes to agent-finance-lead ──
  const financeScore = checkPatterns(lowerText, FINANCE_PATTERNS);
  if (financeScore > 0) {
    return {
      type: 'action',
      confidence: Math.max(financeScore, 0.85),
      reasoning: 'Trading/options query — routed to finance team for full analysis',
      suggestedTeam: 'team-finance',
      suggestedTaskKind: 'research',
    };
  }

  // Check for infrastructure queries
  const infrastructureScore = checkPatterns(lowerText, INFRASTRUCTURE_PATTERNS);
  if (infrastructureScore > 0.3) {
    return {
      type: 'infrastructure',
      confidence: infrastructureScore,
      reasoning: 'Query matches infrastructure patterns (agents, teams, capabilities, architecture)',
    };
  }

  // Check for action queries
  const actionScore = checkPatterns(lowerText, ACTION_PATTERNS);
  if (actionScore > 0.25) {
    const suggestedTeam = suggestTeamFromAction(lowerText);
    const suggestedTaskKind = suggestTaskKindFromAction(lowerText);

    return {
      type: 'action',
      confidence: actionScore,
      reasoning: 'Query matches action patterns (requests to do work, create tasks)',
      suggestedTeam,
      suggestedTaskKind,
    };
  }

  // Simple queries (default)
  const simpleScore = checkPatterns(lowerText, SIMPLE_QUERY_PATTERNS);
  return {
    type: 'simple',
    confidence: simpleScore > 0.3 ? simpleScore : 0.65,
    reasoning: 'Query is general knowledge (not infrastructure, not action)',
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check how many patterns match the text
 * Returns score from 0 to 1
 * Even ONE match gives decent confidence since patterns are highly specific
 */
function checkPatterns(text: string, patterns: RegExp[]): number {
  let matches = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) {
      matches++;
    }
  }

  // If ANY patterns match, return high confidence
  // Because each pattern is specific to its category
  if (matches > 0) {
    return Math.min(0.7 + (matches / patterns.length * 0.3), 1);
  }
  return 0;
}

/**
 * Suggest team based on action keywords
 */
function suggestTeamFromAction(text: string): string | undefined {
  // ── projecT87 — DeFi/Web3 execution (check BEFORE generic finance) ─────────
  if (/\b(defi|web3|blockchain|smart.?contract|mainnet|testnet|rpc|on.?chain|gas fee|solidity|p87|project.?87|liquidity pool|dex|swap|stake|yield|protocol|token (launch|deploy|transfer)|wallet (address|balance|connect))\b/i.test(text)) {
    return 'team-p87';
  }

  // ── Bailey Group — real estate lead pipeline ───────────────────────────────
  if (/\b(propstream|real estate|property|properties|landlord|tenant|lead (score|qualify|call|list)|voice call|crm (update|note|contact)|skip trace|property tour|listing|motivated seller|foreclosure|bail(ey|ey group))\b/i.test(text)) {
    return 'team-bailey';
  }

  // ── The Agency — growth/revops/demand gen ─────────────────────────────────
  if (/\b(growthops|revops|pipelineops|demand gen|inbound (lead|signal|funnel)|outbound (sequence|campaign)|lead generation|sales funnel|drip campaign|agency (pipeline|client|campaign))\b/i.test(text)) {
    return 'team-agency';
  }

  // ── Finance / trading — options + Schwab positions ───────────────────────
  if (/\b(call|put|roll|strike|dte|theta|delta|gamma|options|position|portfolio|chart|signal|setup|trade|trading|spy|spx|tsla|googl|aapl|nvda|thinkorswim|tos|schwab|breakeven|expir|intraday|swing|premarket|vix|rsi|macd|support|resistance|breakout|p&l|pnl|credit|debit|premium)\b/i.test(text)) {
    return 'team-finance';
  }

  if (/\b(build|code|develop|write|implement|fix|refactor)\b/i.test(text)) {
    return 'team-build';
  }
  if (/\b(deploy|configure|infrastructure|setup|monitor)\b/i.test(text)) {
    return 'team-infra';
  }
  if (/\b(wallet|finance|financial|simulate|market)\b/i.test(text)) {
    return 'team-finance';
  }
  if (/\b(marketing|campaign|content|growth|audience)\b/i.test(text)) {
    return 'team-growth';
  }
  if (/\b(intel|repository|github|link|analysis|competitive)\b/i.test(text)) {
    return 'team-intel';
  }
  if (/\b(research|investigate|analyze|find|discover)\b/i.test(text)) {
    return 'team-research';
  }
  return undefined;
}

/**
 * Suggest task kind based on action keywords
 */
function suggestTaskKindFromAction(text: string): string | undefined {
  if (/\b(deep research|thorough|comprehensive|investigation)\b/i.test(text)) {
    return 'deep_research';
  }
  // DeFi/Web3 execution (projecT87 domain)
  if (/\b(defi|web3|blockchain|smart.?contract|mainnet|testnet|on.?chain|p87|project.?87|liquidity|dex|swap|stake)\b/i.test(text)) {
    return 'defi_plan';
  }
  // Bailey lead pipeline
  if (/\b(propstream|lead score|lead qualify|voice call|property tour|real estate lead|motivated seller)\b/i.test(text)) {
    return 'lead_qualification';
  }
  // Agency growth operations
  if (/\b(campaign|demand gen|inbound funnel|outbound sequence|growthops|revops)\b/i.test(text)) {
    return 'campaign_generation';
  }
  if (/\b(research|investigate|analyze|find|discover)\b/i.test(text)) {
    return 'research';
  }
  if (/\b(code|build|implement|develop|feature|bug|fix)\b/i.test(text)) {
    return 'code_change';
  }
  if (/\b(configure|infrastructure|deploy|setup)\b/i.test(text)) {
    return 'config_change';
  }
  if (/\b(wallet|finance|simulate|scenario|model)\b/i.test(text)) {
    return 'wallet_simulation';
  }
  if (/\b(content|marketing|campaign|write|generate)\b/i.test(text)) {
    return 'content_generation';
  }
  if (/\b(intel|repository|github|link|competitive)\b/i.test(text)) {
    return 'intel_review';
  }
  if (/\b(market|trend|research|growth)\b/i.test(text)) {
    return 'market_research';
  }
  return undefined;
}

/**
 * Extract what the user wants to learn/do
 * Used for generating LLM prompts
 */
export function extractQueryIntent(text: string): string {
  return text.trim();
}

/**
 * Check if query is a command (starts with /)
 */
export function isCommand(text: string): boolean {
  return /^\/\w+/i.test(text.trim());
}

/**
 * Extract command name and args if it's a command
 */
export function parseCommand(text: string): { command: string; args: string } | null {
  const match = text.trim().match(/^\/(\w+)\s*(.*)?$/i);
  if (!match) return null;

  return {
    command: match[1].toLowerCase(),
    args: match[2]?.trim() || '',
  };
}

// ============================================================================
// Examples & Testing
// ============================================================================

/**
 * Test the classifier with example queries
 */
export function testClassifier() {
  const testCases = [
    // Infrastructure queries
    'What agents do we have?',
    'Which team handles research?',
    'Tell me about agent-research-lead',
    'What is the bot-nation architecture?',
    'What can the build team do?',

    // Action queries
    'Call these 5 people tomorrow',
    'Build a new feature for user login',
    'Research the latest AI trends',
    'Create a marketing campaign',
    'Simulate a wallet scenario',

    // Simple queries
    'What is the capital of France?',
    'When was the internet invented?',
    'How does photosynthesis work?',
    'Explain machine learning',
  ];

  console.log('\n=== Query Classification Test ===\n');
  for (const query of testCases) {
    const result = classifyQuery(query);
    console.log(`Query: "${query}"`);
    console.log(`Type: ${result.type} (confidence: ${(result.confidence * 100).toFixed(0)}%)`);
    console.log(`Reason: ${result.reasoning}`);
    if (result.suggestedTeam) console.log(`Team: ${result.suggestedTeam}`);
    if (result.suggestedTaskKind) console.log(`Task: ${result.suggestedTaskKind}`);
    console.log();
  }
}
