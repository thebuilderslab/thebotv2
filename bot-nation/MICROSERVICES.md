# Bot-Nation: Microservices Integration

Complete API specifications for all 4 microservices integrated into bot-nation.

## Microservices Overview

| Service | URL | Purpose | Primary Users | Response Time |
|---------|-----|---------|---------------|---|
| **last30days-api** | https://last30days-api.onrender.com | Real-time social + web research | team-research, team-intel, team-growth, team-finance | 2-5s |
| **hermes-api-minimal** | https://hermes-api-minimal.onrender.com | Self-improvement + skill synthesis | team-research, team-build, synthesizer | 3-8s |
| **autoresearchclaw-api** | https://autoresearchclaw-api.onrender.com | Deep academic research (23 stages) | researcher, team-infra, team-bailey | 10-30s |
| **tradingagents-api** | https://tradingagents-api-q747.onrender.com | Multi-agent trading analysis | team-finance (4 agents), team-p87 | 2-4s |

---

## 1. last30days-api

**Purpose**: Multi-platform research spanning social media, news, and web sources  
**Deployed**: https://last30days-api.onrender.com  
**Hosting**: Render (free tier, Python Flask)  
**Status**: Production  

### Endpoint: `/research` (POST)

**Use Cases**:
- Monitor social media sentiment (Twitter, Reddit, Bluesky)
- Track trending news (HN, X, YouTube)
- Research GitHub trends
- Polymarket intelligence
- General web searches

**Request**:
```json
{
  "topic": "TSLA earnings",
  "mode": "quick"
}
```

**Response**:
```json
{
  "topic": "TSLA earnings",
  "report": "TSLA earnings beat expectations Q4 2024...",
  "sources_used": [
    {
      "platform": "twitter",
      "count": 25,
      "sentiment": "bullish"
    },
    {
      "platform": "reddit",
      "count": 15,
      "sentiment": "mixed"
    },
    {
      "platform": "hackernews",
      "count": 3,
      "sentiment": "technical"
    }
  ],
  "confidence": 0.75,
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### Endpoint: `/health` (GET)

**Request**: None

**Response**:
```json
{
  "status": "ok",
  "service": "last30days",
  "uptime_seconds": 3600
}
```

### Configuration

**Environment Variables**:
- `LAST30DAYS_URL`: https://last30days-api.onrender.com
- `LAST30DAYS_API_KEY`: (optional, set on Render dashboard)

**Usage in Code**:
```typescript
// microservice-orchestrator.ts
const response = await fetch(`${env.LAST30DAYS_URL}/research`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(env.LAST30DAYS_API_KEY && { Authorization: `Bearer ${env.LAST30DAYS_API_KEY}` }),
  },
  body: JSON.stringify({ topic: query, mode: "quick" }),
});
```

### Platforms Supported
- Twitter/X (sentiment, volume)
- Reddit (discussion threads, sentiment)
- YouTube (video trends, comments)
- Hacker News (tech trends)
- GitHub (trending repos, stars)
- Bluesky (emerging platform)
- Polymarket (prediction data)

### Integration Points
- **team-research**: Analyze social trends
- **team-intel**: Competitive intelligence
- **team-growth**: User sentiment analysis
- **team-finance**: Sentiment-driven trading signals
- **team-bailey**: Real estate market sentiment

---

## 2. hermes-api-minimal

**Purpose**: Self-improving LLM system for skill synthesis and task learning  
**Deployed**: https://hermes-api-minimal.onrender.com  
**Hosting**: Render (free tier, Python Flask)  
**Status**: Production  
**Based On**: NousResearch/hermes-agent (minimal wrapper)  

### Endpoint: `/reason` (POST)

**Use Cases**:
- Synthesize insights from research
- Create reusable skill procedures
- Self-improve based on task outcomes
- Generate strategic recommendations

**Request**:
```json
{
  "query": "analyze TSLA bullish breakout pattern",
  "context": {
    "create_skill": true,
    "skill_category": "trading_analysis",
    "examples": [...]
  }
}
```

**Response**:
```json
{
  "query": "analyze TSLA bullish breakout pattern",
  "reasoning": "TSLA breaking above 200-day MA indicates bullish momentum...",
  "skill_created": "technical_analysis_breakout_detection",
  "skill_procedure": "1. Check if price breaks 200-day MA\n2. Confirm RSI <70 (room to run)\n3. Check volume (should exceed 20-day avg)\n4. Look for support level below entry",
  "quality_score": 0.82,
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### Endpoint: `/health` (GET)

**Request**: None

**Response**:
```json
{
  "status": "ok",
  "service": "hermes",
  "model": "nous-hermes-2",
  "uptime_seconds": 3600
}
```

### Configuration

**Environment Variables**:
- `HERMES_API_URL`: https://hermes-api-minimal.onrender.com
- `HERMES_API_KEY`: (optional)

**Usage in Code**:
```typescript
const response = await fetch(`${env.HERMES_API_URL}/reason`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(env.HERMES_API_KEY && { Authorization: `Bearer ${env.HERMES_API_KEY}` }),
  },
  body: JSON.stringify({ query, context: { create_skill: true } }),
});
```

### Skill Creation Process

When `create_skill: true`:

1. **Analyze** the query and context
2. **Generate** a procedure (step-by-step)
3. **Rate** quality (0-1 scale)
4. **Store** in D1 skills table
5. **Return** skill_id for future use

### Integration Points
- **synthesizer**: Create skills from research findings
- **team-build**: Generate implementation procedures
- **team-finance**: Create trading strategy skills
- **team-research**: Build procedure library

### Skill Library

Stored in D1 `skills` table:
```sql
id: UUID
name: "Technical Breakout Detection"
description: "Identifies bullish breakout patterns"
trigger_pattern: "breakout|breakup|bullish"
procedure: "Step 1: Check 200-day MA..."
quality_score: 0.82
use_count: 5
version: 1
```

---

## 3. autoresearchclaw-api

**Purpose**: Deep, multi-stage academic research pipeline  
**Deployed**: https://autoresearchclaw-api.onrender.com  
**Hosting**: Render (free tier, Python)  
**Status**: Production  
**Pipeline**: 23-stage research framework  

### Endpoint: `/research` (POST)

**Use Cases**:
- Deep-dive technical analysis
- Academic paper synthesis
- Complex market research
- Regulatory landscape analysis
- Competitive intelligence

**Request**:
```json
{
  "topic": "Smart contract audit best practices",
  "depth": "medium"
}
```

**Depth Levels**:
- `light`: 5-8 stages (fast, ~5-10s)
- `medium`: 12-16 stages (balanced, ~10-30s) [default]
- `deep`: 23 stages (comprehensive, ~30-60s)

**Response**:
```json
{
  "topic": "Smart contract audit best practices",
  "paper": "Smart Contract Security Auditing: A Comprehensive Framework\n\n1. Introduction\n  Security auditing of smart contracts requires...",
  "stages_executed": 16,
  "key_findings": [
    "Use formal verification tools",
    "Implement multi-sig controls",
    "Regular security audits critical"
  ],
  "references": [
    "OpenZeppelin Audit Guide",
    "NIST Cybersecurity Framework"
  ],
  "confidence": 0.78,
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### Endpoint: `/health` (GET)

**Request**: None

**Response**:
```json
{
  "status": "ok",
  "service": "autoresearchclaw",
  "stages_available": 23,
  "uptime_seconds": 3600
}
```

### Configuration

**Environment Variables**:
- `AUTORESEARCHCLAW_URL`: https://autoresearchclaw-api.onrender.com
- `RESEARCH_API_KEY`: (optional)

**Usage in Code**:
```typescript
const response = await fetch(`${env.AUTORESEARCHCLAW_URL}/research`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    ...(env.RESEARCH_API_KEY && { Authorization: `Bearer ${env.RESEARCH_API_KEY}` }),
  },
  body: JSON.stringify({ topic: query, depth: "medium" }),
});
```

### Research Pipeline (23 Stages)

**Stages 1-5: Information Gathering**
1. Query expansion + keyword extraction
2. Academic database search (arXiv, JSTOR, Google Scholar)
3. News + industry report aggregation
4. Source credibility scoring
5. Deduplication + relevance ranking

**Stages 6-12: Analysis & Synthesis**
6. Content extraction + parsing
7. Key concepts identification
8. Connection mapping (concept relationships)
9. Conflicting opinions detection
10. Evidence strength assessment
11. Bias identification + correction
12. Timeline construction (historical context)

**Stages 13-18: Insight Generation**
13. Pattern recognition (across sources)
14. Anomaly detection (surprising findings)
15. Predictive inference (future implications)
16. Risk assessment
17. Opportunity identification
18. Recommendation generation

**Stages 19-23: Output & Validation**
19. Executive summary generation
20. Full paper writing
21. Reference formatting
22. Fact-checking against sources
23. Confidence scoring + caveats

### Integration Points
- **researcher**: Primary user for deep research
- **team-infra**: Infrastructure analysis
- **team-bailey**: Real estate market research
- **team-p87**: DeFi protocol analysis

---

## 4. tradingagents-api

**Purpose**: Multi-agent consensus trading analysis  
**Deployed**: https://tradingagents-api-q747.onrender.com  
**Hosting**: Render (free tier, Python)  
**Status**: Production (newly integrated)  
**Agents**: 4 specialized traders  

### Endpoint: `/analyze` (POST)

**Use Cases**:
- Trading signal generation
- Multi-agent consensus
- Risk assessment
- Portfolio recommendations
- DeFi project evaluation

**Request**:
```json
{
  "query": "analyze TSLA for trading opportunity"
}
```

**Response**:
```json
{
  "query": "analyze TSLA for trading opportunity",
  "agents_involved": [
    "fundamental_analyst",
    "sentiment_analyst",
    "technical_analyst",
    "risk_manager"
  ],
  "analysis": {
    "fundamental": "EPS growth 12% YoY, P/E ratio 18.5 (healthy for growth stock), strong cash flow $8.2B, debt/equity reasonable",
    "sentiment": "Social media +65% positive sentiment, institutional buyers active, retail FOMO signals detected",
    "technical": "Breaking above 200-day MA ($172), RSI 65 (approaching overbought but not yet), bullish divergence forming",
    "risk": "Portfolio concentration: 8% (acceptable for single position), volatility: 28% annualized (manageable), suggest 2% risk per trade"
  },
  "recommendation": "BUY - Strong fundamental + technical + sentiment confluence. Entry: current, Target: +15%, Stop: 5% below 200-day MA",
  "confidence": 0.78,
  "agents_consensus": 4,
  "consensus_strength": "unanimous",
  "timeframe": "3-6 months",
  "risk_level": "moderate",
  "timestamp": "2024-01-15T10:30:00Z"
}
```

### Endpoint: `/health` (GET)

**Request**: None

**Response**:
```json
{
  "status": "ok",
  "service": "tradingagents",
  "agents_active": 4,
  "uptime_seconds": 3600
}
```

### Configuration

**Environment Variables**:
- `TRADING_URL`: https://tradingagents-api-q747.onrender.com
- `TRADING_API_KEY`: (set on Render env vars)

**Usage in Code**:
```typescript
// microservice-orchestrator.ts
const response = await fetch(`${env.TRADING_URL}/analyze`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ query }),
});
```

### Agent Specifications

**1. Fundamental Analyst**
- Analyzes: Financial statements, P/E ratios, earnings, cash flow, debt levels
- Inputs: Company financials, annual reports, earnings transcripts
- Outputs: Valuation metrics, financial health score, rating
- Model: Quantitative financial analysis

**2. Sentiment Analyst**
- Analyzes: Social media sentiment, institutional flows, whale movements, news tone
- Inputs: Twitter, Reddit, news articles, on-chain data (for crypto)
- Outputs: Sentiment score (-100 to +100), trend direction, conviction strength
- Model: NLP + behavioral finance

**3. Technical Analyst**
- Analyzes: Price action, candlestick patterns, technical indicators, support/resistance
- Inputs: OHLCV data, indicator calculations, pattern recognition
- Outputs: Technical signals, chart patterns, indicator confluence, entry/exit points
- Model: Price action + indicator-based

**4. Risk Manager**
- Analyzes: Portfolio concentration, volatility, correlation, drawdown risk
- Inputs: Position sizes, historical returns, correlation matrix
- Outputs: Portfolio risk score, position sizing, VaR estimates
- Model: Modern portfolio theory + risk modeling

### Consensus Model

```
Signal Generation:
┌─────────────────────────────────────────┐
│  Fundamental  │  Sentiment  │  Technical  │  Risk  │
│    Rating     │   Signal    │   Signal    │  Check │
└─────────────────────────────────────────┘
           ↓
    Majority Vote
       ↓
  ┌─────────────────┐
  │  BUY/HOLD/SELL  │
  │  Confidence %   │
  │  Consensus: 4/4 │
  └─────────────────┘
```

**Consensus Levels**:
- **Unanimous** (4/4 agree): Confidence 80%+ → Strong signal
- **3/4 agree**: Confidence 60-75% → Moderate signal
- **2/4 agree**: Confidence 40-55% → Weak signal
- **Split**: Confidence <40% → Wait for clarity

### Integration into bot-nation

**In microservice-orchestrator.ts**:
```typescript
// When classifyQuery returns "action" type + trading/finance keywords:
// → Call orchestrateResearch() which includes callTrading()
// → Merge trading results with other sources
// → synthesizeResults() includes trading recommendation with agent consensus
```

**In nation-supervisor.ts**:
```typescript
// If query matches: /analyze|trading|price|chart|defi/i
// → Route to handleActionQuery()
// → Execute orchestrateResearch (includes trading agents)
// → Return multi-agent consensus + risk assessment
```

### Example Use Cases

**Case 1: Trading Signal Request**
```
User: "should I buy TSLA?"
→ Classification: action (confidence 72%)
→ orchestrateResearch("should I buy TSLA?", env)
→ tradingagents-api /analyze
→ Response: "BUY - Consensus 4/4, confidence 78%"
→ Send to Telegram with recommendation
```

**Case 2: Risk Assessment**
```
User: "what's the risk in my portfolio?"
→ Classification: action (confidence 72%)
→ Provide current portfolio (from context)
→ tradingagents-api /analyze
→ risk_manager highlights concentration + volatility
→ Response: "Concentration 8% in TSLA (acceptable), suggest 2% risk/trade"
```

**Case 3: DeFi Project Analysis**
```
User: "analyze P87 DeFi project"
→ Classification: infrastructure or action
→ tradingagents-api /analyze
→ Sentiment: whale purchases detected (+signals)
→ Technical: token chart breakout forming
→ Fundamental: tokenomics sustainable for 3 years
→ Risk: smart contract not audited (-signal)
→ Response: "HOLD - 3/4 agents positive, smart contract risk noted"
```

---

## Microservice Orchestration Flow

```
handleMessage(userText, userId, chatId, env)
    ↓
classifyQuery(text)
    ├─ Infrastructure? → LLM(Opus) + knowledge base
    ├─ Action? → orchestrateResearch()
    └─ Simple? → LLM(Haiku) + skills
    ↓
orchestrateResearch(query, env)
    ├─ callLast30Days() ─→ Research findings + sentiment
    ├─ callHermes() ─→ Skill synthesis
    ├─ callAutoResearchClaw() ─→ Academic research
    └─ callTrading() ─→ Multi-agent consensus
    ↓
synthesizeResults(sources)
    ├─ Merge all sources
    ├─ Format with metadata
    ├─ Add confidence scores
    └─ Optional skill creation
    ↓
sendMessage(response, Telegram)
```

---

## Error Handling & Fallbacks

**If microservice fails**:
- Promise.allSettled() catches errors
- Service is logged + skipped
- Remaining services continue
- User gets partial results (not failure)

**Example**:
```
User: "analyze TSLA"
→ tradingagents-api DOWN
→ last30days-api works ✓
→ hermes-api works ✓
→ autoresearchclaw-api works ✓
→ Response: "Here's sentiment + research + skills (no trading analysis available)"
```

---

## Performance Targets

| Service | Target Response | Actual | Status |
|---------|-----------------|--------|--------|
| last30days | <5s | 2-5s | ✓ |
| hermes | <8s | 3-8s | ✓ |
| autoresearchclaw | <30s | 10-30s | ✓ |
| tradingagents | <4s | 2-4s | ✓ |
| **Parallel (all 4)** | **<30s** | **~25s** | ✓ |

---

## Health Monitoring

**Cron job (*/5 * * * *)**: Check all microservice health endpoints
- If any DOWN: Page on-call (team-infra SRE)
- If P1 incident: Trigger incident protocol
- If P2 incident: Alert leadership

---

## Future Integrations

1. **OpenRouter API** (video generation)
   - Sora 2 Pro, Veo 3.1, Seedance 1.5 Pro
   - For trading analysis video content

2. **thinkorswim API**
   - Real-time chart data
   - Order entry execution
   - Alerts & notifications

3. **External financial APIs**
   - Alpha Vantage (stock data)
   - CoinGecko (crypto data)
   - Financial Modeling Prep (financials)

4. **Custom ML models**
   - Sentiment prediction
   - Price forecasting
   - Pattern recognition

---

## Next Steps

1. Monitor microservice health (cron jobs)
2. Scale services as traffic grows (Render paid tier)
3. Add circuit breakers + retries
4. Implement caching for repeated queries
5. Build monitoring dashboard (team-infra)
