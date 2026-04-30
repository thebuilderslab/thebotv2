# Bot-Nation Architecture

## Overview
Bot-Nation is a multi-agent Telegram-based research and analysis system built on Cloudflare Workers with persistent D1 database and microservice orchestration.

## Core Pattern: Nation Supervisor
The **Nation Supervisor** acts as a receptionist/gatekeeper that:
1. **Receives** user message via Telegram webhook
2. **Detects** if message is a follow-up (yes/no/go ahead/cancel) using chat history
3. **Classifies** query into one of three types with confidence scoring
4. **Routes** to appropriate handler based on type
5. **Executes** with context (knowledge base, skills, microservices)
6. **Responds** via Telegram with synthesized results
7. **Stores** conversation in D1 for follow-up support

## Message Flow

```
Telegram Message
    ↓
[Handler: handleMessage]
    ↓
[Step 1: Store message in D1]
    ↓
[Step 2: Detect follow-up (yes/no?)]
    ├─ YES → Execute pending action + respond
    └─ NO → Continue to classification
    ↓
[Step 3: Classify query type]
    ├─ Infrastructure (74% conf) → buildKnowledgeBaseContext() + LLM (Opus)
    ├─ Action (72% conf) → orchestrateResearch() in parallel
    └─ Simple (65% conf) → Claude Haiku + skill retrieval
    ↓
[Step 4: Optional skill retrieval]
    ├─ Find relevant skills via trigger patterns
    └─ Inject into system prompt for context
    ↓
[Step 5: Microservice orchestration]
    ├─ last30days-api (social + web trends)
    ├─ hermes-api (skill synthesis + creation)
    ├─ autoresearchclaw-api (academic research)
    └─ tradingagents-api (multi-agent trading)
    ↓
[Step 6: Synthesize results]
    ├─ Merge all sources with metadata (duration, confidence, timestamp)
    ├─ Format into readable response
    └─ Optional skill creation (hermes)
    ↓
[Step 7: Send response + store in D1]
    ├─ Send to Telegram
    ├─ Store assistant message
    └─ Set pending_action if follow-up expected
```

## Query Classification

| Type | Keywords | Threshold | Handler | LLM |
|------|----------|-----------|---------|-----|
| Infrastructure | agent/team/dept/skill/architecture/system | > 0.3 | handleInfrastructureQuery | Opus (detailed) |
| Action | call/build/research/schedule/create/analyze | > 0.25 | handleActionQuery | orchestrateResearch() |
| Simple | (default fallback) | - | handleSimpleQuery | Haiku (fast) |

- **Confidence scoring**: If ANY pattern matches, return 0.7+
- Each query gets type + confidence + suggestedTeam + suggestedTaskKind

## Technology Stack

| Component | Technology | Role |
|-----------|-----------|------|
| **Worker** | Cloudflare Workers | HTTP entry point, webhook handler |
| **HTTP Framework** | Hono | Routing, middleware |
| **Database** | Cloudflare D1 (SQLite) | Persistent chat history, skills, agents |
| **Durable Objects** | Cloudflare DO | AgentActor for stateful operations |
| **AI Models** | Anthropic Claude | Haiku (simple), Opus (complex) |
| **Message Platform** | Telegram Bot API | User interface |

## Key Services

### Nation Supervisor (src/services/nation-supervisor.ts)
- **Main handler**: `handleMessage(userText, userId, chatId, env)`
- **Query routing**: Classify → route → execute
- **Context injection**: buildKnowledgeBaseContext() creates 16-agent data dump
- **Follow-up detection**: isFollowUp() checks for yes/no patterns
- **Skill retrieval**: findRelevantSkills() for context enhancement
- **Skill creation**: createSkillFromTask() after completed research

### Query Classifier (src/services/query-classifier.ts)
- **Function**: `classifyQuery(text)`
- **Returns**: { type, confidence, suggestedTeam, suggestedTaskKind }
- **Pattern matching**: Regex against infrastructure/action keywords
- **Confidence calculation**: 0.7+ if ANY pattern matches

### Chat Memory (src/services/chat-memory.ts)
- **Storage**: D1 chat_messages table
- **Retrieval**: `getRecentHistory(db, chatId, limit)`
- **Follow-up detection**: `isFollowUp(text)` regex patterns
- **Max history**: 10 messages per chat
- **Formats**: Converts to Claude API message format

### Knowledge Base (src/services/knowledge-base.ts)
- **Data**: 16 agents across 9 teams, 6 departments
- **Context building**: `buildKnowledgeBaseContext()` creates system prompt text
- **Lookups**: getAgent(), getTeam(), listAllAgents(), listAllTeams()
- **Formatting**: formatAgentInfo(), formatTeamInfo() for display

### Microservice Orchestrator (src/services/microservice-orchestrator.ts)
- **Function**: `orchestrateResearch(query, env)`
- **Pattern**: Promise.allSettled() for parallel, graceful failure handling
- **Sources**:
  - last30days: `/research` (POST, social + web)
  - hermes: `/reason` (POST, skill synthesis)
  - autoresearchclaw: `/research` (POST, depth: medium)
  - trading: `/analyze` (POST, trading agents)
- **Synthesis**: `synthesizeResults(sources)` merges into readable format
- **Metadata**: duration_ms, confidence, timestamp per source

### Skill Manager (src/services/skill-manager.ts)
- **Creation**: `createSkillFromTask(taskId, taskKind, input, result, db)`
- **Retrieval**: `findRelevantSkills(query, db, limit)` via regex patterns
- **Refinement**: `refineSkill(skillId, qualityDelta, refinement, db)`
- **Formatting**: `formatSkillsForContext(skills)` for LLM injection
- **Tables**: skills, skill_refinements

### LLM Service (src/services/llm-service.ts)
- **Simple answers**: `generateAnswer(query, env)` — Claude Haiku
- **Complex research**: `generateResearch(query, env)` — Claude Opus
- **Prompting**: Caveman mode (terse, 65-75% fewer tokens)
- **Context**: Injects knowledge base, skills, chat history

## Caveman Mode

A terse prompting style injected into all LLM calls:
- **Goal**: Reduce output tokens 65-75%
- **Rules**:
  - Single sentence answers when possible
  - No preamble ("Based on your query...")
  - Direct facts only
  - Numbers > words
  - Bullet points preferred
- **Example**: ❌ "Based on the data you provided, it appears that the fundamental analyst has determined..." → ✅ "PE ratio: 15.3, healthy fundamentals"

## Database Schema (D1)

### chat_messages
```sql
id (primary key)
chat_id (indexed)
user_id
role (user|assistant)
content
query_type (simple|infrastructure|action)
task_id (foreign key)
pending_action (task description if awaiting yes/no)
created_at (indexed)
```

### skills
```sql
id (primary key)
name
description
trigger_pattern (regex for matching queries)
procedure (step-by-step execution)
quality_score (0-100, improved via refinements)
use_count (incremented each use)
version
created_at
```

### skill_refinements
```sql
id (primary key)
skill_id (foreign key)
quality_delta (±points)
refinement (description of improvement)
created_at
```

### agents, teams, departments
```sql
(Full schema in DATABASE_SCHEMA.md)
```

## Webhook Integration

**Endpoint**: POST `/api/telegram/webhook`

**Authentication**:
- Checks chatId against env.TELEGRAM_CHAT_ID
- Rejects unauthorized users

**Request Format**:
```json
{
  "message": {
    "chat": { "id": 12345 },
    "from": { "id": 67890, "username": "user" },
    "text": "analyze TSLA"
  }
}
```

**Response**: Telegram sendMessage API call with Claude response

## Deployment

- **Worker**: https://bot-nation-api.thejamalshackleford.workers.dev
- **Database**: Cloudflare D1 (pbot-nation-db)
- **Cron**: */5 * * * * (every 5 minutes for scheduled tasks)
- **Environment Variables**: See DEPLOYMENT_STATUS.md

## Microservice Ecosystem

All microservices deployed on Render (free tier):

1. **last30days-api** (multi-platform research)
   - URL: https://last30days-api.onrender.com
   - Endpoint: POST /research
   - Input: { topic, mode: "quick" }
   - Output: { report, sources_used[] }

2. **hermes-api-minimal** (self-improvement)
   - URL: https://hermes-api-minimal.onrender.com
   - Endpoint: POST /reason
   - Input: { query, context: { create_skill: true } }
   - Output: { reasoning, skill_created, quality_score }

3. **autoresearchclaw-api** (academic research)
   - URL: https://autoresearchclaw-api.onrender.com
   - Endpoint: POST /research
   - Input: { topic, depth: "medium" }
   - Output: { paper, stages_executed, confidence }

4. **tradingagents-api** (multi-agent trading)
   - URL: https://tradingagents-api-q747.onrender.com
   - Endpoint: POST /analyze
   - Input: { query }
   - Output: { recommendation, confidence, agents_consensus }

## Key Files

| File | Purpose |
|------|---------|
| src/index.ts | Hono app entry, route mounting |
| src/routes/telegram.ts | Webhook handler |
| src/services/nation-supervisor.ts | Main message orchestration |
| src/services/query-classifier.ts | Query type detection |
| src/services/chat-memory.ts | D1 persistence |
| src/services/knowledge-base.ts | Agent/team/dept data |
| src/services/microservice-orchestrator.ts | Parallel API calls |
| src/services/skill-manager.ts | Skill CRUD + retrieval |
| src/services/llm-service.ts | Claude API calls |
| wrangler.jsonc | Cloudflare config |
| migrations/0022_chat_memory.sql | Chat history schema |
| migrations/0023_hermes_skills.sql | Skill system schema |

## Error Handling

- **Microservice failures**: Promise.allSettled() continues even if one fails
- **Classification failures**: Defaults to "simple" query
- **LLM errors**: Returns "Unable to process request"
- **Database errors**: Logged to console, non-blocking

## Next Steps

- **Phase 1**: Define team missions/goals in MISSION_FRAMEWORK.md
- **Phase 2**: Schedule cron jobs for agents in scheduling system
- **Phase 3**: Build UI dashboard (TBD: web/Telegram/Discord?)
