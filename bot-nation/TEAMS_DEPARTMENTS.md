# Bot-Nation: Teams & Departments

Organizational structure defining 9 teams across 6 departments with missions, responsibilities, and reporting relationships.

## Department Overview

```
Bot-Nation Organization (6 Departments)
├── dept-research (Core research & analysis)
│   ├── team-research (3 agents)
│   └── team-intel (1 agent)
├── dept-infra (Engineering & operations)
│   ├── team-build (3 agents)
│   └── team-infra (2 agents)
├── dept-defi (Financial & trading)
│   ├── team-finance (4 agents)
│   └── team-p87 (1 agent)
├── dept-growth (User growth & retention)
│   └── team-growth (1 agent)
├── dept-real-estate (Property & real estate)
│   └── team-bailey (1 agent)
└── dept-sales (Sales & partnerships)
    └── team-agency (1 agent)
```

---

## DEPT-RESEARCH (Core Research & Analysis)

**Department Head**: Research Director  
**Budget Focus**: Tools, data sources, API integrations  
**Strategic Goal**: Establish bot-nation as authoritative knowledge source  

### Team: team-research

**Team Lead**: Research Manager  
**Agents**: 3 (analyst, researcher, synthesizer)  
**Reports To**: Research Director (dept-research)

**Mission Statement**:
> "Transform raw data into actionable insights through systematic analysis, deep investigation, and pattern synthesis. Enable all other teams with research capabilities."

**Responsibilities**:
1. **Data Analysis** (analyst)
   - Process datasets from last30days-api
   - Generate weekly trend reports
   - Identify statistical patterns
   - Create dashboards

2. **Deep Research** (researcher)
   - Conduct literature reviews
   - Synthesize academic papers
   - Investigate emerging technologies
   - Produce white papers

3. **Knowledge Synthesis** (synthesizer)
   - Create reusable skill procedures
   - Connect disparate insights
   - Generate actionable frameworks
   - Build skill library

**Success Metrics**:
- Research report quality scores (1-10 scale)
- Skill creation rate (N skills/week)
- Time from question to insight (target: <24h)
- Team cross-usage rate (how many other teams use research?)

**Dependencies**:
- Upstream: autoresearchclaw-api, last30days-api
- Downstream: All teams (everyone uses research)

**Tools & Systems**:
- autoresearchclaw-api (academic research, 23 stages)
- last30days-api (social + web trends)
- hermes-api (skill creation)
- D1 database (skill storage)

**Team Meetings**:
- Weekly research sync (Monday 10am)
- Bi-weekly skill review (every other Wednesday)
- Monthly strategic planning (last Friday)

---

### Team: team-intel

**Team Lead**: Intelligence Director  
**Agents**: 1 (intel_analyst)  
**Reports To**: Research Director (dept-research)

**Mission Statement**:
> "Monitor competitive landscape, track industry trends, and identify strategic threats and opportunities. Keep bot-nation ahead of market changes."

**Responsibilities**:
1. **Competitive Intelligence**
   - Monitor trading bot competitors
   - Track AI agent developments
   - Identify feature gaps vs. market
   - Alert leadership on threats

2. **Industry Trends**
   - Track regulatory changes
   - Monitor DeFi developments
   - Identify emerging technologies
   - Forecast market movements

3. **Strategic Recommendations**
   - Recommend product pivots
   - Suggest partnership opportunities
   - Identify acquisition targets
   - Propose new capabilities

**Success Metrics**:
- Intelligence report timeliness (target: within 24h of news break)
- Alert accuracy (% of alerts that materialize)
- Strategic recommendations adopted (%)
- Competitive advantage lead time (months ahead of competition)

**Dependencies**:
- Upstream: last30days-api (primary), autoresearchclaw-api
- Downstream: Leadership, team-agency, team-growth

**Tools & Systems**:
- last30days-api (news + social monitoring)
- autoresearchclaw-api (deep research)
- Twitter/X monitoring
- GitHub trending (tech developments)

**Team Meetings**:
- Daily standup (5 min, async)
- Weekly threat briefing (Thursday 2pm)
- Bi-weekly strategic review (with leadership)

---

## DEPT-INFRA (Engineering & Operations)

**Department Head**: VP Engineering  
**Budget Focus**: Infrastructure, CI/CD, monitoring, tooling  
**Strategic Goal**: 99.9% uptime, <100ms response time, zero security incidents  

### Team: team-build

**Team Lead**: Engineering Manager  
**Agents**: 3 (architect, engineer, devops)  
**Reports To**: VP Engineering (dept-infra)

**Mission Statement**:
> "Design and implement scalable, reliable systems that power bot-nation. Own the technical roadmap and architectural decisions."

**Responsibilities**:
1. **System Architecture** (architect)
   - Design new microservices
   - Evaluate technology tradeoffs
   - Plan scalability improvements
   - Review major PRs

2. **Feature Implementation** (engineer)
   - Build new features end-to-end
   - Fix production bugs
   - Optimize database queries
   - Write automated tests

3. **DevOps & Deployment** (devops)
   - Deploy to Cloudflare/Render
   - Manage CI/CD pipelines
   - Configure infrastructure
   - Manage secrets/env vars

**Success Metrics**:
- Feature delivery velocity (stories/sprint)
- Bug escape rate (production bugs per release)
- Code coverage (target: >80%)
- Deployment frequency (target: daily)
- Lead time for changes (target: <2h)

**Dependencies**:
- Upstream: Product, team-intel
- Downstream: team-infra (SRE), all other teams (users of features)

**Tools & Systems**:
- Cloudflare Workers (compute)
- Cloudflare D1 (database)
- Render (microservice hosting)
- GitHub (version control)
- Wrangler (deployment tool)

**Team Meetings**:
- Daily standup (15 min)
- Sprint planning (Monday)
- Sprint retrospective (Friday)
- Architecture review (weekly)
- On-call rotation (24/7 escalation path)

**Current Roadmap**:
- Q2: thinkorswim integration (top 5 methods)
- Q2: UI dashboard (web-based)
- Q3: Mobile app (Telegram bot expansion)
- Q3: Advanced skill system (feedback loops)

---

### Team: team-infra

**Team Lead**: Reliability Engineer  
**Agents**: 2 (sre, ops)  
**Reports To**: VP Engineering (dept-infra)

**Mission Statement**:
> "Keep bot-nation running 24/7 with high reliability, fast incident response, and proactive monitoring. Own operational excellence."

**Responsibilities**:
1. **Site Reliability** (sre)
   - Monitor system health (*/5 cron checks)
   - Respond to incidents (<5 min response time)
   - Implement resilience patterns
   - Track SLAs/SLOs

2. **Operations Management** (ops)
   - Maintain configurations (wrangler.jsonc)
   - Manage environment variables
   - Create runbooks
   - Audit security & compliance

**Success Metrics**:
- Uptime (target: 99.9%, <43 min downtime/month)
- Mean time to detection (MTTD, target: <1 min)
- Mean time to resolution (MTTR, target: <10 min)
- Incident severity distribution (target: 80% P3-P4)
- On-call satisfaction (team feedback)

**Dependencies**:
- Upstream: team-build (new features, deployments)
- Downstream: All teams (everyone depends on uptime)

**Tools & Systems**:
- Cloudflare dashboard (worker monitoring)
- Render dashboard (microservice health)
- Honeycomb or similar (observability)
- PagerDuty (incident management)
- Slack (alerting)

**Monitoring Strategy**:
```
*/5 * * * * → health check cron
  Check: worker /health endpoint
  Check: D1 database connectivity
  Check: Microservice availability (last30days, hermes, autoresearchclaw, trading)
  Action: Alert if any service down (P1 incident)
```

**Team Meetings**:
- Daily standup (10 min)
- Weekly incident review (lessons learned)
- Bi-weekly capacity planning (load forecasting)
- Monthly disaster recovery drill

---

## DEPT-DEFI (Financial & Trading Analysis)

**Department Head**: Chief Investment Officer (CIO)  
**Budget Focus**: Data feeds, trading licenses, financial APIs  
**Strategic Goal**: Accurate trading signals, risk mitigation, profit generation  

### Team: team-finance

**Team Lead**: Trading Desk Manager  
**Agents**: 4 (fundamental_analyst, sentiment_analyst, technical_analyst, risk_manager)  
**Reports To**: Chief Investment Officer (dept-defi)

**Mission Statement**:
> "Provide multi-agent consensus on trading opportunities with high confidence and managed risk. Enable profitable trading decisions."

**Responsibilities**:
1. **Fundamental Analysis** (fundamental_analyst)
   - Analyze financial statements
   - Calculate valuation metrics
   - Assess company health
   - Generate ratings

2. **Sentiment Analysis** (sentiment_analyst)
   - Monitor social sentiment
   - Track institutional positioning
   - Identify retail vs. whale flows
   - Assess market psychology

3. **Technical Analysis** (technical_analyst)
   - Analyze chart patterns
   - Calculate indicators (RSI, MACD, MA)
   - Identify support/resistance
   - Detect breakouts

4. **Risk Management** (risk_manager)
   - Calculate portfolio concentration
   - Assess volatility & drawdown risk
   - Recommend position sizing
   - Identify correlation risks

**Success Metrics**:
- Win rate (% of profitable trades, target: >55%)
- Sharpe ratio (risk-adjusted returns, target: >1.5)
- Max drawdown (target: <20%)
- Agents consensus accuracy (% where all 4 agree, target: >80%)
- Average confidence on winning trades (target: >0.75)

**Dependencies**:
- Upstream: last30days-api (sentiment data), trading data feeds
- Downstream: Risk management, portfolio management, capital allocation

**Tools & Systems**:
- tradingagents-api (/analyze endpoint)
- last30days-api (sentiment + news)
- TradingView / thinkorswim (chart analysis)
- Financial data APIs (earnings, balance sheets)
- Telegram (signal delivery)

**Trading Strategy**:
```
Consensus Model:
- All 4 agents provide independent analysis
- BUY signal: all 4 agents recommend BUY (confidence: high)
- HOLD signal: mixed (2-3 agree, confidence: medium)
- SELL signal: all 4 agents recommend SELL (confidence: high)
- Position size: risk_manager determines (2% risk per trade)
```

**Team Meetings**:
- Daily market open briefing (8:30am)
- Mid-day review (1pm)
- Post-market analysis (4:30pm)
- Weekly strategy session (Friday EOD)
- Monthly performance review

**Current Watchlist**:
- TSLA (high volatility, high volume)
- SPY (broad market index)
- Major DeFi projects (in dept-defi)

---

### Team: team-p87

**Team Lead**: DeFi Specialist  
**Agents**: 1 (p87_analyst)  
**Reports To**: Chief Investment Officer (dept-defi)

**Mission Statement**:
> "Analyze P87 DeFi projects with deep technical expertise. Provide early-stage investment recommendations and risk assessment."

**Responsibilities**:
1. **Protocol Analysis**
   - Analyze smart contracts
   - Evaluate tokenomics
   - Track protocol metrics
   - Assess sustainability

2. **Risk Assessment**
   - Identify smart contract risks
   - Evaluate governance risks
   - Assess team expertise
   - Forecast token unlock impacts

3. **Investment Recommendations**
   - Rate projects on 1-10 scale
   - Recommend entry/exit points
   - Suggest hedge strategies
   - Monitor project developments

**Success Metrics**:
- Project analysis depth (% fully analyzed vs. skipped)
- Early-stage detection (months before mainstream adoption)
- Risk identification accuracy (% of predicted risks that materialize)
- Team satisfaction (feedback from investors)

**Dependencies**:
- Upstream: autoresearchclaw-api (technical analysis), last30days-api (news)
- Downstream: team-finance (trading decisions), investment committee

**Tools & Systems**:
- autoresearchclaw-api (smart contract analysis)
- last30days-api (DeFi news)
- Etherscan/blockchain explorers
- DeFi dashboards (TVL, yields)
- GitHub (code audits)

**Team Meetings**:
- Bi-weekly project deep-dives
- Weekly news briefing
- Monthly investment committee (P87 project updates)

---

## DEPT-GROWTH (User Growth & Retention)

**Department Head**: VP Product & Growth  
**Budget Focus**: Marketing, user research, analytics  
**Strategic Goal**: 10x user base, <5% monthly churn  

### Team: team-growth

**Team Lead**: Growth Lead  
**Agents**: 1 (growth_agent)  
**Reports To**: VP Product & Growth (dept-growth)

**Mission Statement**:
> "Drive user acquisition and retention. Build feedback loops that improve product-market fit. Scale bot-nation adoption."

**Responsibilities**:
1. **User Acquisition**
   - Analyze growth metrics
   - Identify acquisition channels
   - Plan feature rollouts
   - Manage partnerships

2. **Retention & Engagement**
   - Optimize onboarding
   - Track churn causes
   - Improve feature adoption
   - Analyze user cohorts

3. **Analytics & Insights**
   - Monitor KPIs (DAU, MAU, churn, LTV, CAC)
   - Identify bottlenecks
   - A/B test features
   - Report to leadership

**Success Metrics**:
- Monthly active users (MAU, target: 10x by EOY)
- Daily active users (DAU, target: 50% of MAU)
- Monthly churn rate (target: <5%)
- Feature adoption rate (% of users trying new features)
- Time to first value (target: <5 min)
- Net Promoter Score (NPS, target: >50)

**Dependencies**:
- Upstream: team-build (features), team-agency (partnerships)
- Downstream: Revenue, market presence

**Tools & Systems**:
- last30days-api (trend monitoring)
- Telegram analytics
- Google Analytics (if web UI added)
- Mixpanel or Amplitude (custom analytics)
- Slack (notification of milestones)

**Growth Experiments**:
- Telegram bot sharing (viral loop)
- thinkorswim integration (new user segment)
- Web UI dashboard (accessibility)
- API for third-party integrations

**Team Meetings**:
- Weekly growth review (metrics, experiments)
- Bi-weekly strategy planning
- Monthly stakeholder review

---

## DEPT-REAL-ESTATE (Property & Real Estate)

**Department Head**: Real Estate Director  
**Budget Focus**: Real estate data, market research  
**Strategic Goal**: Establish bot-nation as real estate analysis tool  

### Team: team-bailey

**Team Lead**: Bailey Specialist  
**Agents**: 1 (bailey_specialist)  
**Reports To**: Real Estate Director (dept-real-estate)

**Mission Statement**:
> "Provide comprehensive real estate analysis and investment recommendations. Support Bailey Group's portfolio decisions."

**Responsibilities**:
1. **Property Valuation**
   - Analyze comparable properties
   - Calculate cap rates & cash-on-cash returns
   - Assess location quality
   - Estimate NOI

2. **Market Analysis**
   - Track real estate trends
   - Identify emerging markets
   - Forecast price movements
   - Assess neighborhood stability

3. **Investment Recommendations**
   - Rate properties 1-10 scale
   - Recommend buy/hold/sell
   - Identify value-add opportunities
   - Suggest hedge strategies

**Success Metrics**:
- Investment recommendation accuracy (IRR achieved vs. forecast)
- Property analysis speed (hours per analysis)
- Market timing (months ahead of market shifts)
- Portfolio performance (vs. market benchmark)

**Dependencies**:
- Upstream: Real estate data APIs, comps databases
- Downstream: Investment committee, portfolio managers

**Tools & Systems**:
- autoresearchclaw-api (market research)
- Real estate MLS data
- Zillow/Redfin APIs
- CBRE reports (commercial)
- Local county records

**Current Focus Areas**:
- Bailey Group properties
- Commercial real estate (office, retail)
- Residential markets in top 10 metros
- Opportunity zones (tax benefits)

**Team Meetings**:
- Weekly property reviews
- Bi-weekly market briefings
- Monthly investment committee
- Quarterly strategy planning

---

## DEPT-SALES (Sales & Partnerships)

**Department Head**: Chief Revenue Officer (CRO)  
**Budget Focus**: Sales tools, partnership budgets, events  
**Strategic Goal**: Enterprise partnerships, enterprise revenue, $Xmm ARR  

### Team: team-agency

**Team Lead**: Agency Lead  
**Agents**: 1 (agency_lead)  
**Reports To**: Chief Revenue Officer (dept-sales)

**Mission Statement**:
> "Identify and execute strategic partnerships that accelerate bot-nation adoption. Build enterprise sales pipeline."

**Responsibilities**:
1. **Partnership Development**
   - Identify partnership opportunities
   - Negotiate integration agreements
   - Manage partner relationships
   - Support partner GTM

2. **Enterprise Sales**
   - Prospect enterprise accounts
   - Manage sales pipeline
   - Close deals
   - Manage account relationships

3. **Go-to-Market**
   - Plan product launches
   - Create sales collateral
   - Support marketing
   - Track sales metrics

**Success Metrics**:
- New partnerships closed (target: 5/quarter)
- Pipeline generated ($X per quarter)
- Win rate (% of qualified leads → closed)
- Average deal size (target: $Xk)
- Time to close (target: <60 days)
- Partner satisfaction (NPS)

**Dependencies**:
- Upstream: team-build (product features), team-growth (demand)
- Downstream: Revenue, market presence, brand

**Tools & Systems**:
- Salesforce (CRM)
- Slack (communication)
- last30days-api (market monitoring for partnerships)
- LinkedIn (outreach)
- Email (sales)

**Current Partnership Pipeline**:
- Fintech platforms (for trading integration)
- Real estate platforms (Bailey Group expansion)
- DeFi protocols (data sharing)
- Trading communities (adoption)

**Team Meetings**:
- Weekly sales standup
- Bi-weekly pipeline review
- Monthly forecasting
- Quarterly business review

---

## Cross-Department Collaboration

### Information Flows
```
dept-research → All teams (research findings)
dept-intel → Leadership (strategic threats)
dept-infra → All teams (system reliability)
dept-defi → dept-growth (trading signals/features)
dept-growth → dept-sales (user adoption data)
dept-sales → dept-build (partner requirements)
dept-real-estate → dept-sales (expansion opportunities)
```

### Shared Tools & Systems
- **D1 Database**: All teams store/query data
- **Telegram**: All teams communicate with users
- **Slack**: All teams communicate internally
- **GitHub**: team-build manages, all teams monitor
- **Render**: team-infra manages, all teams depend on

### Quarterly Planning
- Q1 Planning (all departments): Jan 2-6
- Mid-year review (all departments): Jul 1-5
- Strategic offsite (leadership): Sep 15-17
- Annual planning (all departments): Dec 1-10

---

## Next Steps

1. **Mission Definition** (This document) ✅
2. **Agent Scheduling** (SCHEDULING.md): Map agents to cron schedules
3. **Performance Dashboards**: Build UI to track team KPIs
4. **Cross-Department Initiatives**: Identify collaboration opportunities
