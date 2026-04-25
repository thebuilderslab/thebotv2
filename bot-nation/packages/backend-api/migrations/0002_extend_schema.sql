-- Migration 0002: extend schema for Step 2 canonical types
-- Adds: proposals, events, tools tables
-- Extends: agents (status, permissions), teams (parent_team_id, policies)

-- ─── agents: replace active:boolean with status + permissions ────────────────

ALTER TABLE agents ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE agents ADD COLUMN permissions TEXT NOT NULL DEFAULT '{"canWriteCode":false,"canModifyAgents":false,"canTouchWallets":false,"canAutoDeploy":false}';

-- Migrate existing active column data into status
UPDATE agents SET status = CASE WHEN active = 1 THEN 'active' ELSE 'retired' END;

-- Drop the legacy active column (requires SQLite >= 3.35.0, which D1 satisfies)
ALTER TABLE agents DROP COLUMN active;

-- ─── teams: add parent hierarchy + governance policy ─────────────────────────

ALTER TABLE teams ADD COLUMN parent_team_id TEXT;
ALTER TABLE teams ADD COLUMN policies TEXT NOT NULL DEFAULT '{"maxRiskTier":"low","requiresHumanApproval":true,"allowedCapabilities":[],"blockedCapabilities":[]}';

-- ─── proposals ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,

  -- Type and target
  type TEXT NOT NULL,                  -- ProposalType enum value
  target_entity_kind TEXT NOT NULL,   -- "agent" | "team" | "policy" | "tool"
  target_entity_id TEXT NOT NULL,

  -- Requester (at most one of these will be non-null per request)
  requester_agent_id TEXT,
  requester_team_id TEXT,
  requester_human_id TEXT,

  -- Human-readable brief
  title TEXT NOT NULL,
  summary TEXT NOT NULL,

  -- The partial patch to apply to the target entity on approval
  change_set TEXT NOT NULL DEFAULT '{}',

  -- Risk assessment
  risk_level TEXT NOT NULL DEFAULT 'low',
  risk_affects_wallets INTEGER NOT NULL DEFAULT 0,    -- 0=false, 1=true
  risk_affects_deployment INTEGER NOT NULL DEFAULT 0,
  risk_notes TEXT,

  -- Evaluation (set by inspector/reviewer agent after proposal is submitted)
  eval_passed INTEGER,                -- NULL=not evaluated, 0=failed, 1=passed
  eval_benchmarks TEXT NOT NULL DEFAULT '[]',
  eval_evaluated_at TEXT,

  -- Links
  approval_id TEXT,                   -- FK → approvals.id (set when pending_approval)

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'draft',
  applied_at TEXT,                    -- set when status = 'applied'

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proposals_status        ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_target        ON proposals(target_entity_kind, target_entity_id);
CREATE INDEX IF NOT EXISTS idx_proposals_approval      ON proposals(approval_id);
CREATE INDEX IF NOT EXISTS idx_proposals_requester_agent ON proposals(requester_agent_id);

-- ─── events ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                 -- EventKind enum value
  actor_id TEXT,                      -- agent or human ID; null for system events
  target_kind TEXT NOT NULL,          -- "agent"|"team"|"proposal"|"approval"|"task"|"tool"
  target_id TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}', -- before/after snapshot, error info, etc.
  session_id TEXT,                    -- groups events from one workflow run
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_kind       ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_target     ON events(target_kind, target_id);
CREATE INDEX IF NOT EXISTS idx_events_session    ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);

-- ─── tools ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- "mcp"|"api"|"script"|"browser"|"internal"
  status TEXT NOT NULL DEFAULT 'pending_review',
  description TEXT,
  endpoint TEXT,
  schema TEXT,                        -- MCP-style JSON Schema (nullable)
  installed_by_agent_id TEXT,
  approval_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tools_status ON tools(status);
CREATE INDEX IF NOT EXISTS idx_tools_kind   ON tools(kind);
