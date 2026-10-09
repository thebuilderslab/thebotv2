-- 0050: Enforce uniqueness of tools.name.
-- SQLite has no ALTER TABLE ADD CONSTRAINT. The tools table was created without
-- UNIQUE on name (0002), so a UNIQUE INDEX is the equivalent, non-destructive fix
-- (no table recreate needed; live table has 10 rows and no duplicate names).
--
-- Intentionally numbered BEFORE 0052_schwab_options_chain_tool.sql. With this
-- index in place, 0052's INSERT OR IGNORE (id 'tool-schwab-options-chain',
-- name 'schwab_options_chain') is ignored because the live row
-- (id 'tool-schwab-options') already owns that name, so no duplicate is created.
-- Slot 0051 is intentionally unused.

CREATE UNIQUE INDEX IF NOT EXISTS uq_tools_name ON tools(name);
