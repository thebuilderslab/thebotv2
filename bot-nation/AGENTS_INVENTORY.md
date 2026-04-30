# Bot-Nation: Agent Inventory

Complete catalog of all 16 agents across 9 teams and 6 departments.

## Team Structure Overview

```
Bot-Nation (9 Teams, 16 Agents, 6 Departments)
├── team-research (Dept: dept-research)
│   ├── analyst (research analyst)
│   ├── researcher (deep research)
│   └── synthesizer (pattern synthesis)
├── team-build (Dept: dept-infra)
│   ├── architect (system design)
│   ├── engineer (implementation)
│   └── devops (infrastructure)
├── team-infra (Dept: dept-infra)
│   ├── sre (site reliability)
│   └── ops (operations)
├── team-finance (Dept: dept-defi)
│   ├── fundamental_analyst (financial analysis)
│   ├── sentiment_analyst (market sentiment)
│   ├── technical_analyst (chart analysis)
│   └── risk_manager (portfolio risk)
├── team-growth (Dept: dept-growth)
│   └── growth_agent (acquisition & retention)
├── team-intel (Dept: dept-research)
│   └── intel_analyst (market intelligence)
├── team-bailey (Dept: dept-real-estate)
│   └── bailey_specialist (real estate focus)
├── team-p87 (Dept: dept-defi)
│   └── p87_analyst (P87 DeFi projects)
└── team-agency (Dept: dept-sales)
    └── agency_lead (sales & partnerships)
```

## Detailed Agent Profiles

### TEAM-RESEARCH (Research & Analysis)

#### 1. **analyst**
- **Full Title**: Research Analyst
- **Team**: team-research
- **Department**: dept-research
- **Expertise**: Data analysis, trend identification, report generation
- **Capabilities**:
  - Analyze structured datasets
  - Identify patterns and anomalies
  - Generate statistical summaries
  - Produce research reports
- **Skills**: Excel, SQL, Python, statistical analysis
- **Typical Tasks**:
  - Analyze user behavior datasets
  - Generate weekly research summaries
  - Track trend evolution over time
- **Integration**: Uses last30days-api for trend data, autoresearchclaw for depth

#### 2. **researcher**
- **Full Title**: Deep Research Specialist
- **Team**: team-research
- **Department**: dept-research
- **Expertise**: Academic research, literature review, comprehensive investigation
- **Capabilities**:
  - Conduct literature reviews
  - Synthesize academic papers
  - Deep-dive investigations
  - Multi-source correlation
- **Skills**: Research methodology, source evaluation, synthesis
- **Typical Tasks**:
  - Investigate new tech trends (AI, blockchain)
  - Produce comprehensive white papers
  - Compare competing technologies
- **Integration**: Primary user of autoresearchclaw-api (23-stage pipeline)

#### 3. **synthesizer**
- **Full Title**: Pattern Synthesizer
- **Team**: team-research
- **Department**: dept-research
- **Expertise**: Pattern recognition, insight generation, knowledge synthesis
- **Capabilities**:
  - Connect disparate data points
  - Generate actionable insights
  - Create skill procedures from learnings
  - Identify emerging patterns
- **Skills**: Systems thinking, pattern recognition, abstraction
- **Typical Tasks**:
  - Create skills from completed research
  - Connect market trends to business impact
  - Generate procedure libraries
- **Integration**: Embedded in hermes-api (skill creation)

---

### TEAM-BUILD (Engineering & Architecture)

#### 4. **architect**
- **Full Title**: System Architect
- **Team**: team-build
- **Department**: dept-infra
- **Expertise**: System design, architecture decisions, scalability planning
- **Capabilities**:
  - Design system components
  - Evaluate architecture tradeoffs
  - Plan scalability improvements
  - Review technical proposals
- **Skills**: Distributed systems, design patterns, performance optimization
- **Typical Tasks**:
  - Design new microservice structure
  - Evaluate thinkorswim integration approaches
  - Plan caching/database strategies
- **Integration**: Consulted for infrastructure queries (classification threshold 74%)

#### 5. **engineer**
- **Full Title**: Implementation Engineer
- **Team**: team-build
- **Department**: dept-infra
- **Expertise**: Code implementation, feature development, debugging
- **Capabilities**:
  - Implement features end-to-end
  - Debug production issues
  - Refactor code for performance
  - Write automated tests
- **Skills**: TypeScript, Python, SQL, testing frameworks
- **Typical Tasks**:
  - Build new API endpoints
  - Fix Telegram webhook issues
  - Optimize database queries
- **Integration**: Creates implementation plans from architect decisions

#### 6. **devops**
- **Full Title**: DevOps Engineer
- **Team**: team-build
- **Department**: dept-infra
- **Expertise**: Deployment, infrastructure, monitoring
- **Capabilities**:
  - Deploy services to Render/Cloudflare
  - Configure CI/CD pipelines
  - Monitor system health
  - Scale services
- **Skills**: Docker, Kubernetes, monitoring, logging
- **Typical Tasks**:
  - Deploy microservices to Render
  - Configure wrangler.jsonc
  - Set environment variables
  - Monitor worker uptime

---

### TEAM-INFRA (Infrastructure & Operations)

#### 7. **sre**
- **Full Title**: Site Reliability Engineer
- **Team**: team-infra
- **Department**: dept-infra
- **Expertise**: Reliability, incident response, system health
- **Capabilities**:
  - Monitor system health
  - Respond to incidents
  - Implement resilience patterns
  - Track SLAs/SLOs
- **Skills**: Monitoring, alerting, incident management
- **Typical Tasks**:
  - Monitor microservice health (*/5 cron check)
  - Trigger alerts if services down
  - Implement circuit breakers
- **Integration**: Runs scheduled cron jobs for health checks

#### 8. **ops**
- **Full Title**: Operations Manager
- **Team**: team-infra
- **Department**: dept-infra
- **Expertise**: System operations, configuration, change management
- **Capabilities**:
  - Manage configurations
  - Oversee deployments
  - Track change logs
  - Maintain documentation
- **Skills**: Configuration management, change control
- **Typical Tasks**:
  - Maintain wrangler.jsonc
  - Update environment variables
  - Create runbooks
- **Integration**: Manages worker configuration and secrets

---

### TEAM-FINANCE (Trading & Financial Analysis)

#### 9. **fundamental_analyst**
- **Full Title**: Fundamental Analyst
- **Team**: team-finance
- **Department**: dept-defi
- **Expertise**: Financial statement analysis, valuation, earnings
- **Capabilities**:
  - Analyze financial statements
  - Calculate valuation metrics (P/E, P/B, PEG)
  - Assess company fundamentals
  - Generate buy/hold/sell ratings
- **Skills**: Financial modeling, valuation, accounting
- **Typical Tasks**:
  - Analyze TSLA P/E ratio, earnings growth
  - Evaluate real estate property values
  - Assess DeFi protocol economics
- **Integration**: Part of tradingagents-api `/analyze` endpoint
- **Example Output**: "EPS growth 12%, P/E ratio 18 (healthy), strong cash flow"

#### 10. **sentiment_analyst**
- **Full Title**: Sentiment Analyst
- **Team**: team-finance
- **Department**: dept-defi
- **Expertise**: Market sentiment, social signals, institutional interest
- **Capabilities**:
  - Analyze social media sentiment
  - Track institutional positioning
  - Identify retail vs. institutional flows
  - Assess fear/greed indicators
- **Skills**: NLP, social listening, behavioral finance
- **Typical Tasks**:
  - Analyze Twitter/Reddit sentiment on stocks
  - Track whale wallets in DeFi
  - Monitor institutional buying
- **Integration**: Part of tradingagents-api `/analyze` endpoint
- **Example Output**: "Social media +65% positive, institutional inflows rising, retail capitulation"

#### 11. **technical_analyst**
- **Full Title**: Technical Analyst
- **Team**: team-finance
- **Department**: dept-defi
- **Expertise**: Chart patterns, technical indicators, price action
- **Capabilities**:
  - Analyze candlestick patterns
  - Calculate technical indicators (RSI, MACD, MA)
  - Identify support/resistance
  - Detect breakout signals
- **Skills**: Chart reading, pattern recognition, indicator analysis
- **Typical Tasks**:
  - Analyze TSLA 4H chart (breaking 200-day MA)
  - Identify head-and-shoulders patterns
  - Calculate RSI divergences
- **Integration**: Part of tradingagents-api `/analyze` endpoint
- **Example Output**: "Breaking above 200-day MA, RSI 65 (not yet overbought), bullish breakout"

#### 12. **risk_manager**
- **Full Title**: Risk Manager
- **Team**: team-finance
- **Department**: dept-defi
- **Expertise**: Portfolio risk, position sizing, volatility management
- **Capabilities**:
  - Calculate portfolio concentration
  - Assess volatility and drawdown risk
  - Recommend position sizing
  - Identify correlation risks
- **Skills**: Risk modeling, portfolio theory, VaR analysis
- **Typical Tasks**:
  - Assess portfolio concentration (8% in TSLA = moderate risk)
  - Calculate optimal position size (risk: 2% per trade)
  - Identify correlated assets
- **Integration**: Part of tradingagents-api `/analyze` endpoint
- **Example Output**: "Concentration: 8% in TSLA (acceptable), volatility manageable, suggest 2% risk per trade"

---

### TEAM-GROWTH (Growth & Acquisition)

#### 13. **growth_agent**
- **Full Title**: Growth Agent
- **Team**: team-growth
- **Department**: dept-growth
- **Expertise**: User acquisition, retention, viral loops, GTM strategy
- **Capabilities**:
  - Analyze growth metrics
  - Identify bottlenecks
  - Plan acquisition strategies
  - Optimize retention funnels
- **Skills**: Growth hacking, data analysis, A/B testing
- **Typical Tasks**:
  - Analyze Telegram bot adoption rate
  - Plan feature rollout strategy
  - Calculate CAC and LTV
- **Integration**: Analyzes bot-nation usage metrics

---

### TEAM-INTEL (Market Intelligence)

#### 14. **intel_analyst**
- **Full Title**: Intelligence Analyst
- **Team**: team-intel
- **Department**: dept-research
- **Expertise**: Competitive intelligence, market research, strategic insights
- **Capabilities**:
  - Monitor competitors
  - Track industry news
  - Identify market threats/opportunities
  - Generate strategic recommendations
- **Skills**: Competitive analysis, OSINT, trend forecasting
- **Typical Tasks**:
  - Monitor trading bot competitors
  - Track AI agent developments
  - Identify partnership opportunities
- **Integration**: Uses last30days-api for competitive intelligence

---

### TEAM-BAILEY (Real Estate)

#### 15. **bailey_specialist**
- **Full Title**: Bailey Specialist (Real Estate Expert)
- **Team**: team-bailey
- **Department**: dept-real-estate
- **Expertise**: Real estate analysis, property valuation, market trends
- **Capabilities**:
  - Evaluate property values
  - Analyze real estate markets
  - Calculate ROI on properties
  - Identify investment opportunities
- **Skills**: Real estate valuation, market analysis, property law
- **Typical Tasks**:
  - Analyze Bailey Group properties
  - Assess commercial real estate markets
  - Calculate cap rates and cash-on-cash returns
- **Integration**: Embedded in knowledge base for real estate queries

---

### TEAM-P87 (DeFi Projects)

#### 16. **p87_analyst**
- **Full Title**: P87 Analyst (DeFi Specialist)
- **Team**: team-p87
- **Department**: dept-defi
- **Expertise**: DeFi protocol analysis, tokenomics, smart contracts
- **Capabilities**:
  - Analyze smart contract risks
  - Evaluate tokenomics
  - Track protocol metrics
  - Assess governance structures
- **Skills**: Smart contract auditing, DeFi mechanics, token analysis
- **Typical Tasks**:
  - Analyze P87 DeFi projects
  - Evaluate token unlock schedules
  - Assess protocol sustainability
- **Integration**: Embedded in knowledge base for DeFi queries

---

### TEAM-AGENCY (Sales & Partnerships)

#### 17. **agency_lead**
- **Full Title**: Agency Lead (Sales & Partnerships)
- **Team**: team-agency
- **Department**: dept-sales
- **Expertise**: Sales strategy, partnerships, business development
- **Capabilities**:
  - Identify partnership opportunities
  - Negotiate deals
  - Manage agency relationships
  - Plan go-to-market strategy
- **Skills**: Sales, negotiation, relationship management
- **Typical Tasks**:
  - Identify bot-nation partnership channels
  - Negotiate API integrations
  - Plan expansion strategy
- **Integration**: Consulted for partnership/business queries

---

## Agent Capabilities Matrix

| Agent | Research | Build | Infra | Finance | Growth | Intel | Real Estate | DeFi | Sales |
|-------|----------|-------|-------|---------|--------|-------|-------------|------|-------|
| analyst | ✓ | | | | | | | | |
| researcher | ✓ | | | | | | | | |
| synthesizer | ✓ | | | | | | | | |
| architect | | ✓ | ✓ | | | | | | |
| engineer | | ✓ | ✓ | | | | | | |
| devops | | ✓ | ✓ | | | | | | |
| sre | | | ✓ | | | | | | |
| ops | | | ✓ | | | | | | |
| fundamental_analyst | | | | ✓ | | | ✓ | ✓ | |
| sentiment_analyst | | | | ✓ | | | | ✓ | |
| technical_analyst | | | | ✓ | | | | | |
| risk_manager | | | | ✓ | | | | ✓ | |
| growth_agent | | | | | ✓ | | | | |
| intel_analyst | | | | | | ✓ | | | |
| bailey_specialist | | | | | | | ✓ | | |
| p87_analyst | | | | | | | | ✓ | |
| agency_lead | | | | | | | | | ✓ |

---

## Agent-to-Microservice Routing

| Agent Group | Primary Microservice | Secondary | Tertiary |
|-------------|--------------------|---------|----|
| Research (analyst, researcher, synthesizer) | autoresearchclaw-api | last30days-api | hermes-api |
| Build (architect, engineer, devops) | hermes-api | last30days-api | - |
| Infra (sre, ops) | autoresearchclaw-api | last30days-api | - |
| Finance (4 agents) | tradingagents-api | last30days-api | hermes-api |
| Growth (growth_agent) | last30days-api | hermes-api | - |
| Intel (intel_analyst) | last30days-api | autoresearchclaw-api | - |
| Real Estate (bailey_specialist) | autoresearchclaw-api | last30days-api | - |
| DeFi (p87_analyst) | tradingagents-api | autoresearchclaw-api | last30days-api |
| Sales (agency_lead) | last30days-api | hermes-api | - |

---

## Using Agent Data in Prompts

**Knowledge Base Context Injection** (buildKnowledgeBaseContext() in nation-supervisor.ts):
- All 16 agents formatted as: "Agent Name (team) — capability list"
- All 9 teams formatted with agents + responsibilities
- All 6 departments with mission statements
- Used in infrastructure query system prompts for LLM context

**Example System Prompt Section**:
```
TEAM STRUCTURE:
team-finance: 4 agents (fundamental_analyst, sentiment_analyst, technical_analyst, risk_manager)
  Mission: Multi-agent trading analysis and financial decision support
  Dept: dept-defi

team-research: 3 agents (analyst, researcher, synthesizer)
  Mission: Deep research synthesis and pattern discovery
  Dept: dept-research
```

---

## Agent Communication Flows

### Example: Trading Query → Finance Team
```
User: "analyze TSLA"
→ Classification: action (confidence 72%)
→ orchestrateResearch("analyze TSLA", env)
→ Parallel calls:
   ├─ tradingagents-api /analyze
   │  └─ fundamental_analyst + sentiment_analyst + technical_analyst + risk_manager
   │     → { recommendation: "BUY", confidence: 0.78, agents_consensus: 4/4 }
   ├─ last30days-api /research
   │  └─ Current events + social trends
   └─ hermes-api /reason
      └─ Skill synthesis + creation
→ synthesizeResults() merges all
→ Send to Telegram
```

### Example: Infrastructure Query → Team-Build + Team-Infra
```
User: "what's the bot-nation architecture?"
→ Classification: infrastructure (confidence 74%)
→ buildKnowledgeBaseContext() + LLM (Opus)
→ System prompt includes: architect capabilities, engineer experience, sre expertise
→ Claude synthesizes using knowledge base
→ Send to Telegram
```

---

## Next Steps

1. **Mission Definition** (MISSION_FRAMEWORK.md): What should each team accomplish quarterly?
2. **Agent Scheduling** (scheduling): Which agents run on which cron schedules?
3. **Agent Assignments**: Who owns each agent in your organization?
4. **Performance Tracking**: How do we measure agent effectiveness?
