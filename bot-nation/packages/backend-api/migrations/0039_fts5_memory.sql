-- 0039: context-mode FTS5 upgrade for agent_memories
-- Before: recallMemories() uses ORDER BY importance DESC (dumb recency sort)
-- After:  BM25 relevance match against current task summary — finance agent
--         asking about GOOGL recalls GOOGL memories, not real estate memories.
--
-- Pattern from mksglu/context-mode: index tool output into SQLite FTS5,
-- return BM25 intent-matched excerpts instead of raw recency dumps.

-- ── FTS5 virtual table backed by agent_memories ───────────────────────────────
-- content=agent_memories means no data duplication — FTS stores the index only.
-- content_rowid=rowid links back to the base table for JOINs.

CREATE VIRTUAL TABLE IF NOT EXISTS agent_memories_fts
  USING fts5(
    summary,
    tags,
    content=agent_memories,
    content_rowid=rowid
  );

-- ── Populate FTS index from existing memories ─────────────────────────────────
INSERT INTO agent_memories_fts(rowid, summary, tags)
SELECT rowid, summary, COALESCE(tags, '[]') FROM agent_memories;

-- ── Triggers to keep FTS in sync with agent_memories ─────────────────────────

CREATE TRIGGER IF NOT EXISTS agent_memories_ai
  AFTER INSERT ON agent_memories BEGIN
    INSERT INTO agent_memories_fts(rowid, summary, tags)
    VALUES (new.rowid, new.summary, COALESCE(new.tags, '[]'));
  END;

CREATE TRIGGER IF NOT EXISTS agent_memories_ad
  AFTER DELETE ON agent_memories BEGIN
    INSERT INTO agent_memories_fts(agent_memories_fts, rowid, summary, tags)
    VALUES ('delete', old.rowid, old.summary, COALESCE(old.tags, '[]'));
  END;

CREATE TRIGGER IF NOT EXISTS agent_memories_au
  AFTER UPDATE ON agent_memories BEGIN
    INSERT INTO agent_memories_fts(agent_memories_fts, rowid, summary, tags)
    VALUES ('delete', old.rowid, old.summary, COALESCE(old.tags, '[]'));
    INSERT INTO agent_memories_fts(rowid, summary, tags)
    VALUES (new.rowid, new.summary, COALESCE(new.tags, '[]'));
  END;
