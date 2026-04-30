-- Hermes-inspired skill system for Nation Supervisor
-- Skills are auto-created after complex tasks and self-improve through use

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  trigger_pattern TEXT,
  procedure TEXT,
  created_from_task_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT,
  use_count INTEGER DEFAULT 0,
  quality_score REAL DEFAULT 0.7,
  version INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_skills_name ON skills(name);
CREATE INDEX IF NOT EXISTS idx_skills_trigger ON skills(trigger_pattern);
CREATE INDEX IF NOT EXISTS idx_skills_quality ON skills(quality_score DESC);

CREATE TABLE IF NOT EXISTS skill_refinements (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  refinement_type TEXT,
  change_summary TEXT,
  before_procedure TEXT,
  after_procedure TEXT,
  quality_delta REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (skill_id) REFERENCES skills(id)
);

CREATE INDEX IF NOT EXISTS idx_skill_refinements_skill ON skill_refinements(skill_id);
