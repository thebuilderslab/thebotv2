# Bot-Nation: Skills Catalog

Complete documentation of the skill creation, retrieval, and refinement system.

## Skill System Overview

The skill system enables bot-nation to **learn from experience** and **improve over time**.

**Key Concept**: A skill is a reusable procedure triggered by similar queries, stored in D1, with a quality score that improves as the skill is used and refined.

---

## Skill Lifecycle

```
Task Completion
    ↓
Task Output → hermes-api /reason
    ↓
Skill Generated (procedure + trigger pattern)
    ↓
Stored in D1 (quality_score = 0.5)
    ↓
Used in Future Queries (when pattern matches)
    ↓
User Feedback / Refinement
    ↓
Quality Score Improved (0.5 → 0.6 → 0.7 → 0.8)
    ↓
Skill Library Grows
```

---

## Skill Structure

**Example Skill**:

```json
{
  "id": "skill_technical_breakout_detection",
  "name": "Technical Breakout Detection",
  "description": "Identifies bullish breakout patterns in price charts using price action and volume",
  "trigger_pattern": "breakout|breakup|bullish|above.*ma|resistance|price.*action",
  "procedure": "1. Check if price breaks 200-day MA (bullish signal)\n2. Confirm RSI <70 (room to run)\n3. Check volume (>20-day avg by 50%+)\n4. Identify support below entry\n5. Set stop 2-3% below support\n6. 1:3 risk/reward minimum",
  "quality_score": 0.82,
  "use_count": 5,
  "version": 1,
  "created_at": "2024-01-10T10:30:00Z",
  "updated_at": "2024-01-15T14:22:00Z"
}
```

---

## Skill Creation Process

### Step 1: Task Completion
User asks a question → bot-nation researches → result generated

```
User: "Analyze TSLA for trading opportunities"
→ orchestrateResearch() called in parallel
→ hermes-api, last30days, autoresearchclaw, tradingagents all return results
```

### Step 2: Skill Synthesis
hermes-api `/reason` endpoint generates a reusable procedure

**Payload**:
```json
{
  "query": "analyze TSLA for trading opportunities",
  "context": {
    "create_skill": true,
    "skill_category": "trading_analysis",
    "task_result": {
      "fundamental": "EPS growth 12%, PE 18.5",
      "sentiment": "Social +65% bullish",
      "technical": "Breaking 200-day MA",
      "risk": "Portfolio 8%, volatility manageable"
    }
  }
}
```

**Response**:
```json
{
  "skill_created": "skill_trading_confluence_analysis",
  "skill_procedure": "1. Analyze fundamental health (earnings, PE, cash flow)\n2. Check sentiment signals (social media, whale movements)...",
  "quality_score": 0.68,
  "reasoning": "Strong confluence when fundamental + sentiment + technical all align..."
}
```

### Step 3: Storage
Skill stored in D1 `skills` table with initial quality_score = 0.5-0.7

```sql
INSERT INTO skills 
(id, name, description, trigger_pattern, procedure, quality_score, version)
VALUES 
('skill_trading_confluence_analysis',
 'Trading Confluence Analysis',
 'Identifies high-conviction trading opportunities when fundamental + sentiment + technical signals align',
 'confluence|align|all.*agree|fundamental.*sentiment.*technical|multi.*factor',
 '1. Analyze fundamental...',
 0.68,
 1);
```

### Step 4: Usage & Improvement
Every time skill is used:
- `use_count` incremented
- Quality feedback collected
- Refinements applied over time

```typescript
// In nation-supervisor.ts: findRelevantSkills()
const skills = await skillManager.findRelevantSkills(query, db);
// Filter by trigger_pattern match
// Sort by quality_score DESC (best first)

// After using skill
await skillManager.refineSkill(
  skillId,
  qualityDelta: 0.05,  // or -0.05 if poor result
  refinement: "Added volume confirmation rule"
);
```

---

## Skill Retrieval

When a new query comes in, system searches for relevant skills:

### Query Matching Algorithm

```typescript
// skill-manager.ts: findRelevantSkills()
export async function findRelevantSkills(
  query: string,
  db: D1Database,
  limit: number = 5
): Promise<Skill[]> {
  // Build regex patterns from all skills
  const skills = await db.prepare(`
    SELECT id, trigger_pattern, quality_score, use_count 
    FROM skills 
    WHERE status = 'active'
  `).all();
  
  // Score each skill
  const scored = skills.map(skill => ({
    ...skill,
    score: matchScore(query, skill.trigger_pattern)
  }));
  
  // Sort by quality_score DESC (best performers first)
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => 
      b.quality_score - a.quality_score 
      || b.use_count - a.use_count
    )
    .slice(0, limit);
}

function matchScore(query: string, pattern: string): number {
  try {
    const regex = new RegExp(pattern, 'i');
    return regex.test(query) ? 1.0 : 0;
  } catch {
    return 0;
  }
}
```

### Skill Injection into System Prompt

When skills are found, they're formatted and injected into Claude's system prompt:

```typescript
// In handleSimpleQuery()
const relevantSkills = await skillManager.findRelevantSkills(query, db);

const skillContext = skillManager.formatSkillsForContext(relevantSkills);

const systemPrompt = `
You are bot-nation, a research and analysis agent.

RELEVANT SKILLS (use if applicable):
${skillContext}

User Query: ${query}
Conversation History: [last 5 messages]

Answer concisely (caveman mode).
`;

const response = await llmService.generateAnswer(query, env, { systemPrompt });
```

### Formatted Skills Example

```
RELEVANT SKILLS (use if applicable):

1. Technical Breakout Detection (quality: 0.82, used 5x)
   Trigger: breakout|bullish|above.*ma
   Steps:
   - Check 200-day MA break
   - Confirm RSI <70 (room to run)
   - Validate volume >20-day avg by 50%+
   - Set stop 2-3% below support
   
2. Trading Confluence Analysis (quality: 0.68, used 2x)
   Trigger: confluence|multi-factor|all.*agree
   Steps:
   - Fundamental analysis (earnings, PE)
   - Sentiment analysis (social, institutional)
   - Technical analysis (chart patterns)
   - Risk assessment (concentration, volatility)
```

---

## Skill Refinement

As skills are used, feedback is collected and applied via refinements:

### Refinement Triggers

1. **User Explicit Feedback**: "Yes, this skill worked!" / "No, didn't help"
2. **Outcome Measurement**: "Trade was profitable" / "Trade lost"
3. **Quality Regression**: Skill quality drops below 0.6
4. **Community Voting**: Other users rate skill effectiveness

### Refinement Execution

```typescript
// skill-manager.ts: refineSkill()
export async function refineSkill(
  skillId: string,
  qualityDelta: number,  // ±0.1 to ±0.3
  refinement: string,    // Description of improvement
  db: D1Database
): Promise<void> {
  // 1. Create refinement record
  await db.prepare(`
    INSERT INTO skill_refinements 
    (id, skill_id, quality_delta, refinement)
    VALUES (?, ?, ?, ?)
  `).bind(
    generateUUID(),
    skillId,
    qualityDelta,
    refinement
  ).run();
  
  // 2. Update skill quality
  await db.prepare(`
    UPDATE skills 
    SET quality_score = MAX(0, MIN(1, quality_score + ?)), 
        updated_at = CURRENT_TIMESTAMP 
    WHERE id = ?
  `).bind(qualityDelta, skillId).run();
}
```

### Refinement Examples

| Skill | Quality Before | Refinement | Quality After | Notes |
|-------|---|---|---|---|
| Technical Breakout | 0.68 | Added volume confirmation | 0.78 | +0.10 improvement |
| Trading Confluence | 0.58 | Removed weak signals filter | 0.68 | +0.10 improvement |
| Sentiment Analysis | 0.72 | Changed threshold -70 to -65 | 0.65 | -0.07, threshold too aggressive |
| Fundamental Valuation | 0.60 | Simplified PE calculation | 0.70 | +0.10 improvement |

---

## Current Skill Library (Q1 2024)

**Status**: Starting from 0, target 50+ by end of Q1

### Trading Skills (In Progress)

| Skill | Trigger Pattern | Quality | Use Count | Owner |
|-------|---|---|---|---|
| Technical Breakout Detection | breakout\|above.*ma | 0.82 | 5 | technical_analyst |
| Trading Confluence Analysis | confluence\|all.*agree | 0.68 | 2 | synthesizer |
| Sentiment Detection | sentiment\|bullish\|bearish | 0.70 | 8 | sentiment_analyst |
| Fundamental Valuation | earnings\|pe\|valuation | 0.65 | 4 | fundamental_analyst |
| Risk Assessment | risk\|position.*size\|drawdown | 0.72 | 6 | risk_manager |

### Research Skills (In Progress)

| Skill | Trigger Pattern | Quality | Use Count | Owner |
|-------|---|---|---|---|
| Academic Paper Summary | academic\|paper\|research | 0.75 | 3 | researcher |
| Trend Analysis | trend\|pattern\|analysis | 0.70 | 7 | analyst |
| Data Visualization | chart\|graph\|visual | 0.68 | 2 | analyst |

### Real Estate Skills (Planned)

| Skill | Trigger Pattern | Quality | Use Count | Owner |
|-------|---|---|---|---|
| Property Valuation | valuation\|price\|appraisal | - | 0 | bailey_specialist |
| Market Analysis | market\|trend\|forecast | - | 0 | bailey_specialist |
| ROI Calculation | roi\|return\|cash.*flow | - | 0 | bailey_specialist |

### DeFi Skills (Planned)

| Skill | Trigger Pattern | Quality | Use Count | Owner |
|-------|---|---|---|---|
| Tokenomics Analysis | tokenomics\|token.*unlock | - | 0 | p87_analyst |
| Smart Contract Risk | contract\|audit\|risk | - | 0 | p87_analyst |
| Protocol Evaluation | protocol\|governance\|dao | - | 0 | p87_analyst |

---

## Skill Quality Scoring

**Quality Scale**: 0.0 → 1.0

| Score | Interpretation | Action |
|-------|---|---|
| 0.0-0.3 | Poor, unreliable | Archive, don't show to users |
| 0.3-0.5 | Untested, new | Show to advanced users only |
| 0.5-0.7 | Good, decent track record | Show to all users |
| 0.7-0.85 | Very good, proven | Promoted, shown first |
| 0.85-1.0 | Excellent, highly reliable | Featured, recommended |

**Quality Adjustments**:
- New skill starts at 0.5 (neutral)
- Each successful use: +0.01 to +0.05
- Each refinement: +0.05 to +0.15 (or -0.05 if regression)
- User rating (5★): +0.10
- User rating (1★): -0.10

---

## Skill Performance Metrics

### Success Rate Calculation

```typescript
export function calculateSuccessRate(
  skillId: string,
  results: {
    attempt_count: number;
    success_count: number;
    failure_count: number;
    neutral_count: number;
  }
): number {
  // Success rate = successful outcomes / total attempts
  return results.success_count / results.attempt_count;
}
```

### Win Rate for Trading Skills

```typescript
// For trading signals
win_rate = profitable_trades / total_trades

// Example:
// 55 profitable trades, 45 losing trades
// win_rate = 55/100 = 55%
// This is the "quality" signal for trading skills
```

### Usage Patterns

```typescript
export function analyzeUsagePatterns(
  skillId: string,
  uses: Array<{
    timestamp: string;
    query: string;
    success: boolean;
  }>
): {
  daily_uses: number;
  success_rate: number;
  improvement_trend: 'increasing' | 'stable' | 'declining';
} {
  // Analyze skill usage over time
  // Calculate daily use average
  // Detect improvement trend
}
```

---

## Skill Archival & Deprecation

When a skill quality drops or becomes obsolete:

```sql
-- Archive old skill
UPDATE skills 
SET status = 'archived', version = version + 1 
WHERE id = 'skill_old_pattern'
  AND quality_score < 0.3;

-- Mark as deprecated (replaced by newer version)
UPDATE skills 
SET status = 'deprecated', 
    replacement_skill_id = 'skill_new_pattern' 
WHERE id = 'skill_old_pattern';
```

**Retention Policy**:
- Keep all skills (no deletion)
- Archive if quality <0.3
- Replace with better version if found
- Maintain audit trail of all versions

---

## Integration with LLM

### System Prompt Injection

```typescript
// Full system prompt with skills
const systemPrompt = `
You are bot-nation, a multi-agent research and analysis platform.

CAPABILITIES:
- Multi-platform research (Twitter, Reddit, news, academic papers)
- Real-time trading signals (technical + fundamental + sentiment)
- DeFi protocol analysis
- Real estate market analysis
- Risk management & portfolio analysis

LEARNED SKILLS (apply if relevant):
${skillContext}

RESPONSE STYLE:
- Concise (caveman mode: 65-75% fewer tokens)
- Cite sources when available
- Quantify claims (numbers > words)
- List format when possible

Current Date: ${new Date().toISOString()}
Conversation History: [...]

User: ${query}
`;
```

### Skill Context Building

```typescript
const skillContext = relevantSkills
  .map((skill, idx) => `
${idx + 1}. ${skill.name} (quality: ${skill.quality_score}, used ${skill.use_count}x)
   Trigger: ${skill.trigger_pattern}
   Procedure:
   ${skill.procedure.split('\n').map(line => `   ${line}`).join('\n')}
  `)
  .join('\n\n');
```

---

## Feedback Loop Integration

### User Feedback Collection

```typescript
// After sending response to user
const userFeedback = {
  skill_ids_used: ['skill_technical_breakout', 'skill_confluence'],
  user_rating: 5,  // or 1-5 stars
  comments: "Great analysis, very helpful",
  outcome: "trade_was_profitable"
};

// Update skills based on feedback
for (const skillId of userFeedback.skill_ids_used) {
  const qualityDelta = userFeedback.user_rating > 3 ? 0.05 : -0.05;
  await skillManager.refineSkill(
    skillId,
    qualityDelta,
    `User feedback: ${userFeedback.comments}`
  );
}
```

### A/B Testing Skills

```typescript
// Test two versions of same skill
const skillA = await db.prepare(
  `SELECT * FROM skills WHERE id = 'skill_breakout_v1'`
).first();

const skillB = await db.prepare(
  `SELECT * FROM skills WHERE id = 'skill_breakout_v2'`
).first();

// Route 50% of queries to A, 50% to B
const useSkill = Math.random() > 0.5 ? skillA : skillB;

// Track outcomes separately
// Version with better win_rate wins
```

---

## Skill Library Management

### Export Skills for Backup
```bash
# Export all skills as JSON
npx wrangler d1 execute pbot-nation-db \
  --command "SELECT * FROM skills" \
  --format json > skills_backup.json
```

### Analyze Skill Effectiveness
```sql
-- Top performing skills
SELECT name, quality_score, use_count, 
       ROUND(quality_score * use_count, 2) as impact
FROM skills 
WHERE status = 'active'
ORDER BY impact DESC 
LIMIT 10;

-- Skills needing improvement
SELECT name, quality_score, use_count 
FROM skills 
WHERE quality_score < 0.6 
ORDER BY quality_score ASC;
```

### Skill Deprecation Report
```sql
-- Skills that should be archived
SELECT name, quality_score, updated_at 
FROM skills 
WHERE quality_score < 0.3 
  AND updated_at < datetime('now', '-30 days');
```

---

## Future Enhancements

1. **Skill Chaining**: Use output of one skill as input to another
2. **Community Rating**: Users rate skill effectiveness (like product reviews)
3. **Skill Versioning**: Keep multiple versions, auto-promote winners
4. **Federated Learning**: Share skills across bot-nation instances
5. **Explainability**: Generate explanations for skill recommendations

---

## Dashboard Metrics (To Be Built)

```
SKILLS DASHBOARD
├── Total Skills: 23
├── Average Quality: 0.68
├── Most Used: Technical Breakout (8 uses)
├── Highest Quality: Academic Summary (0.85)
├── Recently Refined: Trading Confluence (updated 2h ago)
└── Trending: Sentiment Detection (+0.10 in last week)
```

---

**Document Version**: 1.0  
**Last Updated**: 2024-01-15  
**Next Update**: 2024-02-15 (Skills milestone review)
