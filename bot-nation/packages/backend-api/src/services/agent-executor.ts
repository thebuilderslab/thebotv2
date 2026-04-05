/**
 * Agent Executor — Phase 4
 *
 * Loads a task, builds a Claude prompt from agent context + notes,
 * calls the Anthropic API, stores the response as an artifact,
 * and marks the task completed (or failed on error).
 *
 * Only executes safe, read-only task kinds: research, content_generation.
 * All other kinds require proposal approval (Phase 5).
 */

import Anthropic from "@anthropic-ai/sdk";
import { query, queryOne, run } from "../db/schema";

const EXECUTABLE_KINDS = new Set(["research", "content_generation"]);

export interface ExecuteTaskResult {
  ok: boolean;
  output?: string;
  artifactId?: string;
  error?: string;
}

interface TaskRow {
  id: string;
  kind: string;
  input: string;
  assigned_agent_id: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  role: string;
  description: string | null;
}

interface NoteRow {
  key: string;
  value: string;
}

export async function executeTask(
  db: D1Database,
  apiKey: string,
  taskId: string,
): Promise<ExecuteTaskResult> {
  const now = new Date().toISOString();

  // ── 1. Load task ────────────────────────────────────────────────────────────
  const task = await queryOne<TaskRow>(
    db,
    "SELECT id, kind, input, assigned_agent_id FROM tasks WHERE id = ?",
    [taskId],
  );

  if (!task) {
    return { ok: false, error: `Task ${taskId} not found` };
  }

  // Cost guardrail: only safe kinds
  if (!EXECUTABLE_KINDS.has(task.kind)) {
    await run(db, "UPDATE tasks SET status='failed', updated_at=? WHERE id=?", [now, taskId]);
    await emitEvent(db, taskId, {
      from: "running", to: "failed",
      note: `kind '${task.kind}' requires proposal approval — skipped in Phase 4`,
    }, now);
    return { ok: false, error: `kind '${task.kind}' not executable in Phase 4` };
  }

  if (!task.assigned_agent_id) {
    await run(db, "UPDATE tasks SET status='failed', updated_at=? WHERE id=?", [now, taskId]);
    await emitEvent(db, taskId, { from: "running", to: "failed", note: "no assigned agent" }, now);
    return { ok: false, error: "no assigned agent" };
  }

  // ── 2. Load agent ───────────────────────────────────────────────────────────
  const agent = await queryOne<AgentRow>(
    db,
    "SELECT id, name, role, description FROM agents WHERE id = ?",
    [task.assigned_agent_id],
  );

  if (!agent) {
    await run(db, "UPDATE tasks SET status='failed', updated_at=? WHERE id=?", [now, taskId]);
    await emitEvent(db, taskId, { from: "running", to: "failed", note: "assigned agent not found" }, now);
    return { ok: false, error: "assigned agent not found" };
  }

  // ── 3. Load agent notes ─────────────────────────────────────────────────────
  const notes = await query<NoteRow>(
    db,
    "SELECT key, value FROM agent_notes WHERE agent_id = ?",
    [agent.id],
  );

  const notesText = notes.length > 0
    ? notes.map((n) => `${n.key}: ${n.value}`).join("\n")
    : "(no stored memory)";

  // ── 4. Build prompt ─────────────────────────────────────────────────────────
  let taskInput: { summary?: string; details?: string } = {};
  try { taskInput = JSON.parse(task.input) as typeof taskInput; } catch { /* ignore */ }

  const systemPrompt = [
    `You are ${agent.name}, a ${agent.role} agent in Bot Nation.`,
    agent.description ?? "",
    "",
    "Your memory:",
    notesText,
    "",
    "Complete the task given to you. Be concise and specific. Return a structured response.",
  ].join("\n").trim();

  const userMessage = [
    taskInput.summary ?? "",
    taskInput.details ? `\n\nDetails: ${taskInput.details}` : "",
  ].join("").trim();

  // ── 5. Call Claude ──────────────────────────────────────────────────────────
  let responseText: string;
  try {
    const anthropic = new Anthropic({ apiKey });
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    });

    const block = message.content[0];
    responseText = block?.type === "text" ? block.text : JSON.stringify(message.content);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await run(db, "UPDATE tasks SET status='failed', updated_at=? WHERE id=?", [now, taskId]);
    await emitEvent(db, taskId, { from: "running", to: "failed", note: `Claude API error: ${errMsg}` }, now);
    return { ok: false, error: errMsg };
  }

  // ── 6. Store artifact ───────────────────────────────────────────────────────
  const artifactId = crypto.randomUUID();
  await run(
    db,
    `INSERT INTO artifacts (id, kind, name, url, content, task_id, created_at, updated_at)
     VALUES (?, 'log', ?, '', ?, ?, ?, ?)`,
    [artifactId, `${taskId}-output`, responseText, taskId, now, now],
  );

  // ── 7. Update task → completed ──────────────────────────────────────────────
  const outputJson = JSON.stringify({ summary: responseText.slice(0, 200), artifactIds: [artifactId] });
  await run(
    db,
    "UPDATE tasks SET status='completed', output=?, updated_at=? WHERE id=?",
    [outputJson, now, taskId],
  );

  await emitEvent(db, taskId, {
    from: "running",
    to: "completed",
    note: "executed by agent executor",
    artifactId,
  }, now);

  return { ok: true, output: responseText, artifactId };
}

async function emitEvent(
  db: D1Database,
  taskId: string,
  payload: Record<string, unknown>,
  now: string,
): Promise<void> {
  const id = crypto.randomUUID();
  await run(
    db,
    `INSERT INTO events (id, kind, actor_id, target_kind, target_id, payload, session_id, created_at, updated_at)
     VALUES (?, 'task.status_changed', NULL, 'task', ?, ?, NULL, ?, ?)`,
    [id, taskId, JSON.stringify(payload), now, now],
  );
}
