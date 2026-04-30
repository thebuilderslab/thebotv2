# Bot-Nation: Database Schema

Complete D1 (SQLite) database schema for bot-nation persistent storage.

## Database: pbot-nation-db

**Host**: Cloudflare D1  
**Type**: SQLite  
**Timezone**: UTC  
**Connection**: Cloudflare Workers via env.DB binding  

---

## Table 1: chat_messages

**Purpose**: Store all user/assistant messages for conversation history and follow-up support  
**Rows**: ~100k (estimated at scale)  
**Primary Index**: (chat_id, created_at)  

```sql
CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,          -- UUID v4
  chat_id INTEGER NOT NULL,     -- Telegram chat ID
  user_id INTEGER,              -- Telegram user ID (nullable for channels)
  role TEXT NOT NULL,           -- 'user' | 'assistant'
  content TEXT NOT NULL,        -- Message body (max 4000 chars)
  query_type TEXT,              -- 'simple' | 'infrastructure' | 'action' (assistant only)
  task_id TEXT,                 -- Reference to created task/skill (optional)
  pending_action TEXT,          -- If yes/no response expected: "what should I do?"
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX idx_chat_messages_chat_id ON chat_messages(chat_id);
CREATE INDEX idx_chat_messages_created_at ON chat_messages(created_at);
CREATE INDEX idx_chat_messages_user_id ON chat_messages(user_id);
```

**Schema Details**:

| Column | Type | Null | Default | Notes |
|--------|------|------|---------|-------|
| id | TEXT | N | - | UUID generated in nation-supervisor |
| chat_id | INT | N | - | Telegram chat ID, unique per conversation |
| user_id | INT | Y | - | Telegram user ID for DM tracking |
| role | TEXT | N | - | 'user' \| 'assistant' |
| content | TEXT | N | - | Full message text (truncated if >4000 chars) |
| query_type | TEXT | Y | - | Classification: 'simple', 'infrastructure', 'action' |
| task_id | TEXT | Y | - | Links to task/skill created from this message |
| pending_action | TEXT | Y | - | If awaiting follow-up (yes/no), store the context |
| created_at | DATETIME | N | now() | Indexed for range queries |

**Usage Examples**:

```sql
-- Get last 10 messages for a chat (for LLM context)
SELECT * FROM chat_messages 
WHERE chat_id = 12345 
ORDER BY created_at DESC 
LIMIT 10;

-- Check if awaiting follow-up
SELECT pending_action FROM chat_messages 
WHERE chat_id = 12345 AND role = 'assistant' 
ORDER BY created_at DESC 
LIMIT 1;

-- Analyze query type distribution
SELECT query_type, COUNT(*) 
FROM chat_messages 
WHERE role = 'assistant' 
GROUP BY query_type;

-- Find messages that created skills
SELECT * FROM chat_messages 
WHERE task_id IS NOT NULL 
ORDER BY created_at DESC;
```

**Retention Policy**:
- Keep all messages (valuable for learning)
- Archive messages >6 months old (optional)
- Never delete (compliance/audit trail)

---

## Table 2: skills

**Purpose**: Store reusable procedures and patterns learned from completed tasks  
**Rows**: ~50-100 (grows with system learning)  
**Primary Index**: (trigger_pattern, quality_score DESC)  

```sql
CREATE TABLE skills (
  id TEXT PRIMARY KEY,                    -- UUID v4 / "skill_technical_breakout_detection"
  name TEXT NOT NULL UNIQUE,              -- "Technical Breakout Detection"
  description TEXT,                       -- What the skill does
  trigger_pattern TEXT NOT NULL,          -- Regex: "breakout|breakup|bullish"
  procedure TEXT NOT NULL,                -- Step-by-step instructions
  quality_score REAL DEFAULT 0.5,         -- 0-1 scale, improved via refinements
  use_count INTEGER DEFAULT 0,            -- Incremented each use
  version INTEGER DEFAULT 1,              -- For deprecation tracking
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  CHECK (quality_score >= 0 AND quality_score <= 1)
);

CREATE INDEX idx_skills_trigger_pattern ON skills(trigger_pattern);
CREATE INDEX idx_skills_quality_score ON skills(quality_score DESC);
CREATE INDEX idx_skills_created_at ON skills(created_at DESC);
```

**Schema Details**:

| Column | Type | Null | Default | Notes |
|--------|------|------|---------|-------|
| id | TEXT | N | - | UUID or descriptive slug |
| name | TEXT | N | UNIQUE | Human-readable skill name |
| description | TEXT | Y | - | What problem it solves |
| trigger_pattern | TEXT | N | - | Regex to match similar queries |
| procedure | TEXT | N | - | Numbered steps, ~500-1000 chars |
| quality_score | REAL | N | 0.5 | 0-1, starts at 0.5, refined over time |
| use_count | INT | N | 0 | Incremented when used |
| version | INT | N | 1 | For skill evolution tracking |
| created_at | DATETIME | N | now() | When skill was created |
| updated_at | DATETIME | N | now() | Last refinement |

**Example Row**:
```sql
INSERT INTO skills VALUES (
  'skill_technical_breakout_detection',
  'Technical Breakout Detection',
  'Identifies bullish breakout patterns in price charts',
  'breakout|breakup|bullish|above.*ma|resistance',
  '1. Check if price breaks 200-day MA (bullish signal)
2. Confirm RSI <70 (room to run, not yet overbought)
3. Check volume (should exceed 20-day average by >50%)
4. Identify nearest support level below entry
5. Set stop loss 2-3% below support
6. Risk/reward ratio should be 1:3 minimum',
  0.82,
  5,
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
);
```

**Usage Examples**:

```sql
-- Find skills matching query
SELECT * FROM skills 
WHERE trigger_pattern LIKE '%breakout%' 
ORDER BY quality_score DESC, use_count DESC;

-- Top 10 most-used skills
SELECT name, use_count, quality_score 
FROM skills 
ORDER BY use_count DESC 
LIMIT 10;

-- Skills with low quality (need improvement)
SELECT name, quality_score, use_count 
FROM skills 
WHERE quality_score < 0.5 
ORDER BY quality_score ASC;

-- Increment use count
UPDATE skills 
SET use_count = use_count + 1 
WHERE id = 'skill_technical_breakout_detection';
```

**Skill Creation Flow**:
1. Task completes (e.g., "analyze TSLA for trading opportunity")
2. hermes-api synthesizes → generates procedure
3. synthesizer creates skill with quality_score = 0.5
4. Skill stored in D1
5. Every use increments use_count
6. Feedback loop refines quality_score

---

## Table 3: skill_refinements

**Purpose**: Track skill improvement over time with audit trail  
**Rows**: ~200-500 (3-5 refinements per skill on average)  
**Primary Index**: (skill_id, created_at DESC)  

```sql
CREATE TABLE skill_refinements (
  id TEXT PRIMARY KEY,                    -- UUID v4
  skill_id TEXT NOT NULL,                 -- FK to skills(id)
  quality_delta REAL NOT NULL,            -- ±0.1 to ±0.3 per refinement
  refinement TEXT NOT NULL,               -- "Simplified procedure, added volume confirmation"
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (skill_id) REFERENCES skills(id),
  CHECK (quality_delta >= -0.5 AND quality_delta <= 0.5)
);

CREATE INDEX idx_skill_refinements_skill_id ON skill_refinements(skill_id);
CREATE INDEX idx_skill_refinements_created_at ON skill_refinements(created_at DESC);
```

**Schema Details**:

| Column | Type | Null | Default | Notes |
|--------|------|------|---------|-------|
| id | TEXT | N | - | UUID |
| skill_id | TEXT | N | - | Reference to skill being refined |
| quality_delta | REAL | N | - | Change in quality score (±0.1 to ±0.3) |
| refinement | TEXT | N | - | Description of improvement |
| created_at | DATETIME | N | now() | When refinement applied |

**Example Row**:
```sql
INSERT INTO skill_refinements VALUES (
  'refinement_uuid_123',
  'skill_technical_breakout_detection',
  0.15,
  'Improved RSI threshold detection: changed from <70 to <65 for clearer signals. Added volume confirmation rule.',
  CURRENT_TIMESTAMP
);
```

**Usage Examples**:

```sql
-- View skill improvement history
SELECT quality_delta, refinement, created_at 
FROM skill_refinements 
WHERE skill_id = 'skill_technical_breakout_detection' 
ORDER BY created_at DESC;

-- Calculate cumulative quality improvement
SELECT skill_id, SUM(quality_delta) as total_improvement 
FROM skill_refinements 
GROUP BY skill_id 
ORDER BY total_improvement DESC;

-- Refinements in last 30 days
SELECT sr.*, s.name 
FROM skill_refinements sr 
JOIN skills s ON sr.skill_id = s.id 
WHERE sr.created_at > datetime('now', '-30 days');
```

---

## Table 4: agents

**Purpose**: Master list of all 16 agents with metadata  
**Rows**: 16 (static, grows if new agents added)  
**Primary Index**: (team_id)  

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,                    -- 'analyst', 'researcher', 'fundamental_analyst', etc.
  name TEXT NOT NULL UNIQUE,              -- "Research Analyst"
  team_id TEXT NOT NULL,                  -- FK to teams(id)
  expertise TEXT,                         -- "Data analysis, trend identification"
  capabilities TEXT,                      -- JSON array or pipe-separated
  status TEXT DEFAULT 'active',           -- 'active' | 'inactive' | 'archived'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE INDEX idx_agents_team_id ON agents(team_id);
CREATE INDEX idx_agents_status ON agents(status);
```

**Schema Details**:

| Column | Type | Null | Default | Notes |
|--------|------|------|---------|-------|
| id | TEXT | N | - | Slug: analyst, researcher, etc. |
| name | TEXT | N | UNIQUE | "Research Analyst" |
| team_id | TEXT | N | - | Team this agent belongs to |
| expertise | TEXT | Y | - | Key skills/domain areas |
| capabilities | TEXT | Y | - | JSON or pipe-separated list |
| status | TEXT | N | active | 'active' \| 'inactive' \| 'archived' |
| created_at | DATETIME | N | now() | When agent was onboarded |

**Example Rows**:
```sql
INSERT INTO agents VALUES 
('analyst', 'Research Analyst', 'team-research', 'Data analysis, trends', 'analyze|trends|data|statistics', 'active', CURRENT_TIMESTAMP),
('fundamental_analyst', 'Fundamental Analyst', 'team-finance', 'Financial analysis, valuation', 'earnings|pe|ratio|financials', 'active', CURRENT_TIMESTAMP),
('technical_analyst', 'Technical Analyst', 'team-finance', 'Chart analysis, indicators', 'breakout|rsi|macd|chart', 'active', CURRENT_TIMESTAMP),
('risk_manager', 'Risk Manager', 'team-finance', 'Portfolio risk, sizing', 'risk|volatility|concentration|drawdown', 'active', CURRENT_TIMESTAMP);
```

---

## Table 5: teams

**Purpose**: Team structure with department mapping  
**Rows**: 9 (static)  
**Primary Index**: (department_id)  

```sql
CREATE TABLE teams (
  id TEXT PRIMARY KEY,                    -- 'team-research', 'team-finance', etc.
  name TEXT NOT NULL UNIQUE,              -- "Research Team"
  department_id TEXT NOT NULL,            -- FK to departments(id)
  mission TEXT,                           -- Team mission statement
  lead_agent TEXT,                        -- Primary agent or person
  status TEXT DEFAULT 'active',           -- 'active' | 'inactive' | 'archived'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  
  FOREIGN KEY (department_id) REFERENCES departments(id),
  FOREIGN KEY (lead_agent) REFERENCES agents(id)
);

CREATE INDEX idx_teams_department_id ON teams(department_id);
CREATE INDEX idx_teams_status ON teams(status);
```

---

## Table 6: departments

**Purpose**: Department structure for organizational hierarchy  
**Rows**: 6 (static)  
**Primary Index**: none (small table)  

```sql
CREATE TABLE departments (
  id TEXT PRIMARY KEY,                    -- 'dept-research', 'dept-defi', etc.
  name TEXT NOT NULL UNIQUE,              -- "Research Department"
  mission TEXT,                           -- Department mission
  head_agent TEXT,                        -- Lead agent or person
  status TEXT DEFAULT 'active',           -- 'active' | 'inactive'
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## Table 7: tasks (optional, for future use)

**Purpose**: Track research/build tasks with results  
**Rows**: ~1000s (grows with system activity)  
**Primary Index**: (user_id, created_at DESC)  

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,                    -- UUID v4
  user_id INTEGER NOT NULL,               -- Telegram user ID
  chat_id INTEGER NOT NULL,               -- Telegram chat ID
  query TEXT NOT NULL,                    -- Original user query
  task_kind TEXT,                         -- 'research', 'build', 'analysis', etc.
  status TEXT,                            -- 'pending', 'running', 'completed', 'failed'
  result TEXT,                            -- JSON result from microservice
  assigned_agents TEXT,                   -- Pipe-separated: "analyst|researcher|synthesizer"
  skill_id TEXT,                          -- Skill created from this task
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  
  FOREIGN KEY (skill_id) REFERENCES skills(id)
);

CREATE INDEX idx_tasks_user_id ON tasks(user_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_created_at ON tasks(created_at DESC);
```

---

## Table 8: metrics (optional, for analytics)

**Purpose**: Track system health and performance  
**Rows**: ~500-1000 per day at scale  
**Primary Index**: (created_at DESC)  

```sql
CREATE TABLE metrics (
  id TEXT PRIMARY KEY,                    -- UUID v4
  metric_type TEXT NOT NULL,              -- 'query_count', 'response_time', 'error_rate'
  metric_value REAL,                      -- Numeric value
  metric_unit TEXT,                       -- 'count', 'ms', 'percent'
  context TEXT,                           -- JSON: {"classification":"action", "service":"trading"}
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_metrics_type ON metrics(metric_type);
CREATE INDEX idx_metrics_created_at ON metrics(created_at DESC);
```

---

## Usage Patterns

### Get Recent Chat History (for LLM context)
```typescript
// chat-memory.ts: getRecentHistory()
const messages = await db
  .prepare(`
    SELECT role, content 
    FROM chat_messages 
    WHERE chat_id = ? 
    ORDER BY created_at DESC 
    LIMIT ?
  `)
  .bind(chatId, MAX_HISTORY)
  .all();

// Format for Claude API
return messages.reverse().map(m => ({
  role: m.role,
  content: m.content
}));
```

### Find Relevant Skills
```typescript
// skill-manager.ts: findRelevantSkills()
const skills = await db
  .prepare(`
    SELECT * FROM skills 
    WHERE trigger_pattern LIKE ? 
    ORDER BY quality_score DESC, use_count DESC 
    LIMIT ?
  `)
  .bind(`%${pattern}%`, limit)
  .all();
```

### Create New Skill
```typescript
// skill-manager.ts: createSkillFromTask()
await db
  .prepare(`
    INSERT INTO skills 
    (id, name, description, trigger_pattern, procedure, quality_score, version)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `)
  .bind(
    skillId,
    taskName,
    description,
    triggerPattern,
    procedure,
    0.5  // Start at middle quality
  )
  .run();
```

### Refine Existing Skill
```typescript
// skill-manager.ts: refineSkill()
// Step 1: Create refinement record
await db
  .prepare(`
    INSERT INTO skill_refinements 
    (id, skill_id, quality_delta, refinement)
    VALUES (?, ?, ?, ?)
  `)
  .bind(refinementId, skillId, qualityDelta, refinementText)
  .run();

// Step 2: Update skill quality
await db
  .prepare(`
    UPDATE skills 
    SET quality_score = quality_score + ?, updated_at = CURRENT_TIMESTAMP 
    WHERE id = ?
  `)
  .bind(qualityDelta, skillId)
  .run();
```

---

## Performance Optimizations

1. **Indexes**: All tables indexed on frequently-queried columns
2. **Partitioning**: chat_messages partitioned by chat_id for faster queries
3. **Archival**: Old messages (>6 months) moved to archive table
4. **Caching**: Skills cached in memory (Durable Objects) to avoid repeated DB hits

---

## Backup & Recovery

**Backup Strategy**:
- Daily snapshots via Cloudflare D1 backups
- Export chat_messages weekly for audit trail
- Skills exported monthly for disaster recovery

**Recovery Procedure**:
1. Restore from snapshot (Cloudflare D1 dashboard)
2. Verify data integrity (row counts, recent data)
3. Test skills + agents functioning
4. Alert users of any data loss

---

## Data Privacy & Compliance

**User Data**:
- Chat messages stored with chat_id (not encrypted)
- User IDs stored (Telegram user_id)
- No PII beyond Telegram account
- Retention: indefinite (for system learning)

**Compliance**:
- GDPR: Users can request chat export
- CCPA: Users can request data deletion (archive, don't purge)
- Audit trail: skill_refinements table provides full history

---

## Migrations

Migrations located in: `migrations/`

- `0022_chat_memory.sql`: Initial chat_messages + indexes
- `0023_hermes_skills.sql`: Skills + skill_refinements tables
- (Future): agents, teams, departments tables
- (Future): tasks, metrics tables

---

## Next Steps

1. **Query Optimization**: Monitor slow queries via D1 dashboard
2. **Schema Evolution**: Add new tables as features grow
3. **Analytics Dashboard**: Build UI to visualize metrics/skills
4. **Data Exploration**: Export skills to analyze effectiveness
