/**
 * Memory Service — MemPalace-style persistent agent memory
 *
 * Stores distilled task summaries + learned facts per agent in D1.
 * Injected into each agent's system prompt so they remember past context
 * across Telegram sessions and cron runs.
 *
 * Architecture: D1 text store (Phase 1).
 * Upgrade path: swap recallMemories() for Cloudflare Vectorize semantic search
 * once the index is provisioned (wrangler vectorize create agent-memories).
 *
 * Goose-inspired: mirrors block/goose memory tool pattern — store after every
 * significant task, recall top-N at task start.
 */

import { run, query } from "../db/schema";

const MAX_MEMORIES_PER_AGENT = 50;   // rotate out old low-importance ones
const RECALL_LIMIT = 6;              // memories injected into each system prompt

export interface Memory {
  id: string;
  agent_id: string;
  summary: string;
  source_kind: string;
  task_id: string | null;
  importance: number;
  tags: string;
  created_at: string;
}

// ── Store a memory ────────────────────────────────────────────────────────────
// Call after a significant task completes with a 1-3 sentence distillation.

export async function storeMemory(
  db: D1Database,
  agentId: string,
  summary: string,
  options: {
    taskId?: string;
    importance?: 1 | 2 | 3;  // 1=low 2=medium 3=high
    tags?: string[];
    sourceKind?: "task" | "operator_note" | "self_learn";
  } = {},
): Promise<string> {
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();

  await run(db,
    `INSERT INTO agent_memories (id, agent_id, summary, source_kind, task_id, importance, tags, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      agentId,
      summary.slice(0, 600), // cap at 600 chars — keep prompts lean
      options.sourceKind ?? "task",
      options.taskId ?? null,
      options.importance ?? 2,
      JSON.stringify(options.tags ?? []),
      now,
      now,
    ],
  );

  // Rotate: keep only the most recent MAX_MEMORIES_PER_AGENT per agent
  // (delete oldest low-importance memories first)
  await run(db,
    `DELETE FROM agent_memories
     WHERE agent_id = ?
       AND id NOT IN (
         SELECT id FROM agent_memories
         WHERE agent_id = ?
         ORDER BY importance DESC, created_at DESC
         LIMIT ?
       )`,
    [agentId, agentId, MAX_MEMORIES_PER_AGENT],
  );

  return id;
}

// ── Recall memories ───────────────────────────────────────────────────────────
// With taskQuery: FTS5 BM25 relevance match — returns memories semantically
//   relevant to the current task (context-mode pattern from mksglu/context-mode).
//   Finance agent asking about GOOGL recalls GOOGL memories, not real estate ones.
// Without taskQuery: falls back to importance+recency sort.

export async function recallMemories(
  db: D1Database,
  agentId: string,
  limit = RECALL_LIMIT,
  taskQuery?: string,
): Promise<Memory[]> {
  if (taskQuery && taskQuery.trim().length > 3) {
    // Sanitise: strip FTS5 special chars to avoid query parse errors
    const safeQuery = taskQuery
      .replace(/["""''()^*:]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .split(" ")
      .filter((w) => w.length > 2)
      .slice(0, 8)                   // cap at 8 terms to keep query lean
      .join(" OR ");                 // OR logic = broader relevance match

    if (safeQuery) {
      try {
        const results = await query<Memory>(
          db,
          `SELECT m.id, m.agent_id, m.summary, m.source_kind, m.task_id,
                  m.importance, m.tags, m.created_at
           FROM agent_memories_fts fts
           JOIN agent_memories m ON m.rowid = fts.rowid
           WHERE agent_memories_fts MATCH ?
             AND m.agent_id = ?
           ORDER BY rank, m.importance DESC
           LIMIT ?`,
          [safeQuery, agentId, limit],
        );
        // Fall through to recency sort if FTS returns nothing
        if (results.length > 0) return results;
      } catch {
        // FTS5 query syntax error or missing table — silently fall through
      }
    }
  }

  // Fallback: importance + recency (original behaviour)
  return query<Memory>(
    db,
    `SELECT id, agent_id, summary, source_kind, task_id, importance, tags, created_at
     FROM agent_memories
     WHERE agent_id = ?
     ORDER BY importance DESC, created_at DESC
     LIMIT ?`,
    [agentId, limit],
  );
}

// ── Format memories for system prompt injection ───────────────────────────────

export function formatMemoriesForPrompt(memories: Memory[]): string {
  if (memories.length === 0) return "";

  const lines = memories.map((m) => {
    const date  = m.created_at.slice(0, 10); // YYYY-MM-DD
    const stars = m.importance === 3 ? "★★★" : m.importance === 2 ? "★★" : "★";
    return `[${date}] ${stars} ${m.summary}`;
  });

  return `## Past context (${memories.length} memories)\n${lines.join("\n")}`;
}

// ── Auto-distill task output into a memory ────────────────────────────────────
// Call at end of executeTask() to persist what the agent learned/did.
// Uses a lightweight heuristic — for richer distillation, call the LLM.

export function distillTaskOutput(
  taskKind: string,
  taskSummary: string,
  output: string,
): { summary: string; importance: 1 | 2 | 3; tags: string[] } {
  // Truncate output to first ~400 chars for the memory
  const snippet = output.slice(0, 400).replace(/\n+/g, " ").trim();

  // Infer importance by task kind
  const highKinds = ["intel_review", "code_change", "content_generation"];
  const lowKinds  = ["research"];
  const importance: 1 | 2 | 3 =
    highKinds.includes(taskKind) ? 3 :
    lowKinds.includes(taskKind)  ? 1 : 2;

  // Extract ticker symbols mentioned (naive regex)
  const tickerMatches = output.match(/\b([A-Z]{2,5})\b/g) ?? [];
  const commonWords = new Set(["THE","AND","FOR","USE","GET","NOT","ARE","ALL","NEW","HAS","ANY","CAN"]);
  const tickers = [...new Set(tickerMatches.filter((t) => !commonWords.has(t)))].slice(0, 5);

  const tags: string[] = [taskKind, ...tickers];

  return {
    summary: `[${taskKind}] ${taskSummary}: ${snippet}`,
    importance,
    tags,
  };
}
