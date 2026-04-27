-- 0041: Register `edit_file_section` tool for agent-build-lead
--
-- Why: submit_code_change requires the agent to regenerate the FULL file content,
-- which costs ~12k tokens per change. For small surgical edits (rename a variable,
-- fix a single line, add an import) we want a ~500-token "old_string/new_string"
-- patch. The endpoint internally reads the current file, validates that
-- old_string appears exactly once, swaps it for new_string, and submits the
-- result through the same pending_approval + Telegram preview flow as
-- submit_code_change. The operator review experience is unchanged.

INSERT OR IGNORE INTO tools (id, name, kind, description, schema, endpoint, status, created_at, updated_at)
VALUES (
  'tool-edit-file-section',
  'edit_file_section',
  'http_api',
  'Surgical single-section edit. PREFER THIS over submit_code_change when changing fewer than ~30 lines — it costs ~10x fewer tokens because you only send the snippet. The endpoint reads the current file from GitHub, validates that old_string appears EXACTLY ONCE, replaces it with new_string, and submits through the same operator-review flow. RULES: (1) old_string must be present verbatim in the current file (whitespace and indentation matter), (2) old_string must be unique — include 1-3 lines of surrounding context if a short snippet would otherwise match multiple places, (3) you do NOT need to call read_github_file first (the endpoint reads internally). For bulk rewrites or new files, use submit_code_change.',
  '{"type":"object","properties":{"path":{"type":"string","description":"Repo-relative path e.g. packages/backend-api/src/routes/finance.ts"},"old_string":{"type":"string","description":"Exact substring currently in the file. Must match verbatim (incl. whitespace) and appear exactly once. Include surrounding context if needed for uniqueness."},"new_string":{"type":"string","description":"Replacement text. Empty string to delete the old_string."},"commit_message":{"type":"string","description":"Concise git commit message (imperative, under 72 chars)"},"change_summary":{"type":"string","description":"Plain-English description of what you changed and why — shown to operator in the Telegram preview."}},"required":["path","old_string","new_string","commit_message","change_summary"]}',
  'https://bot-nation-api.thejamalshackleford.workers.dev/api/build/edit-section',
  'active',
  datetime('now'),
  datetime('now')
);
