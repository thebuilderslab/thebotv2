/**
 * Agent Executor — Phase 5
 *
 * Loads a task, builds a Claude prompt from agent context + notes,
 * runs a tool-use loop (max 10 iterations), handles sub-task spawning,
 * synthesizes child results for re-executed parent tasks,
 * stores output as artifact, and marks task completed.
 */

import Anthropic from "@anthropic-ai/sdk";
import { query, queryOne, run } from "../db/schema";
import { executeTool } from "./tool-executor";
import { routeTask } from "./task-router";

const EXECUTABLE_KINDS = new Set(["research", "content_generation"]);
const MAX_TOOL_ITERATIONS = 10;

export interface ExecuteTaskResult {
  ok: boolean;
  output?: string;
  artifactId?: string;
  spawned?: boolean;
  error?: string;
}

interface TaskRow {
  id: string;
  kind: string;
  input: string;
  output: string | null;
  assigned_agent_id: string | null;
  parent_task_id: string | null;
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

interface ToolRow {
  name: string;
  description: string | null;
  schema: string | null;
}

interface ChildTaskRow {
  id: string;
  kind: string;
  output: string | null;
}

interface ToolCallLog {
  name: string;
  input: Record<string, unknown>;
  result: unknown;
  ok: boolean;
}

export async function executeTask(
  db: D1Database,
  apiKey: string,
  taskId: string,
  braveApiKey?: string,
  searxngBaseUrl?: string,
): Promise<ExecuteTaskResult> {
  const now = new Date().toISOString();

  // ── 1. Load task ────────────────────────────────────────────────────────────
  const task = await queryOne<TaskRow>(
    db,
    "SELECT id, kind, input, output, assigned_agent_id, parent_task_id FROM tasks WHERE id = ?",
    [taskId],
  );

  if (!task) return { ok: false, error: `Task ${taskId} not found` };

  if (!EXECUTABLE_KINDS.has(task.kind)) {
    await run(db, "UPDATE tasks SET status='failed', updated_at=? WHERE id=?", [now, taskId]);
    await emitEvent(db, taskId, {
      from: "running", to: "failed",
      note: `kind '${task.kind}' not auto-executable — requires proposal`,
    }, now);
    return { ok: false, error: `kind '${task.kind}' not executable` };
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

  // ── 4. Load active tools ────────────────────────────────────────────────────
  const toolRows = await query<ToolRow>(
    db,
    "SELECT name, description, schema FROM tools WHERE status = 'active'",
    [],
  );

  const anthropicTools: Anthropic.Tool[] = toolRows.map((t) => ({
    name: t.name,
    description: t.description ?? t.name,
    input_schema: (t.schema
      ? JSON.parse(t.schema)
      : { type: "object", properties: {} }) as Anthropic.Tool["input_schema"],
  }));

  // ── 5. Load child results (if this is a parent re-execution) ────────────────
  const children = await query<ChildTaskRow>(
    db,
    "SELECT id, kind, output FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC",
    [taskId],
  );

  const childResultsText = children.length > 0
    ? children.map((c, i) => {
        let out: unknown = null;
        try { out = c.output ? JSON.parse(c.output) : null; } catch { out = c.output; }
        return `Child ${i + 1} (${c.kind}): ${JSON.stringify(out)}`;
      }).join("\n\n")
    : "";

  // ── 6. Build prompt ─────────────────────────────────────────────────────────
  let taskInput: { summary?: string; details?: string } = {};
  try { taskInput = JSON.parse(task.input) as typeof taskInput; } catch { /* ignore */ }

  const systemPrompt = [
    `You are ${agent.name}, a ${agent.role} agent in Bot Nation.`,
    agent.description ?? "",
    "",
    "Your memory:",
    notesText,
    "",
    "Complete the task given to you. Be concise and specific.",
    "",
    "If you need to delegate work to parallel sub-tasks, output a spawn block at the END of your response:",
    "<SPAWN_TASKS>",
    '[{"kind":"research","summary":"...","details":"..."},{"kind":"content_generation","summary":"..."}]',
    "</SPAWN_TASKS>",
    "After outputting SPAWN_TASKS, stop — your final response will be assembled from children.",
  ].join("\n").trim();

  const userMessage = [
    childResultsText ? `[Results from sub-tasks]\n${childResultsText}\n\n[Original Task]` : "",
    taskInput.summary ?? "",
    taskInput.details ? `\n\nDetails: ${taskInput.details}` : "",
    childResultsText ? "\n\nSynthesize the sub-task results into a final structured response." : "",
  ].join("").trim();

  // ── 7. Tool-use loop ────────────────────────────────────────────────────────
  const anthropic = new Anthropic({ apiKey });
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];
  const toolCallLog: ToolCallLog[] = [];
  let finalText = "";
  let iterations = 0;

  try {
    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;

      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        system: systemPrompt,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
        messages,
      });

      if (response.stop_reason === "end_turn") {
        // Extract final text
        const textBlock = response.content.find((b) => b.type === "text");
        finalText = textBlock?.type === "text" ? textBlock.text : JSON.stringify(response.content);
        break;
      }

      if (response.stop_reason === "tool_use") {
        // Append assistant message
        messages.push({ role: "assistant", content: response.content });

        // Execute each tool call and collect results
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const block of response.content) {
          if (block.type !== "tool_use") continue;

          const toolInput = block.input as Record<string, unknown>;
          const callResult = await executeTool(db, { searxngBaseUrl, braveApiKey }, block.name, toolInput);

          toolCallLog.push({
            name: block.name,
            input: toolInput,
            result: callResult.result ?? callResult.error,
            ok: callResult.ok,
          });

          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: callResult.ok
              ? JSON.stringify(callResult.result)
              : `Error: ${callResult.error}`,
          });
        }

        messages.push({ role: "user", content: toolResults });
        continue;
      }

      // Unexpected stop reason — extract any text and break
      const textBlock = response.content.find((b) => b.type === "text");
      finalText = textBlock?.type === "text" ? textBlock.text : "";
      break;
    }

    if (iterations >= MAX_TOOL_ITERATIONS && !finalText) {
      throw new Error(`tool loop exceeded max iterations (${MAX_TOOL_ITERATIONS})`);
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await run(db, "UPDATE tasks SET status='failed', updated_at=? WHERE id=?", [now, taskId]);
    await emitEvent(db, taskId, { from: "running", to: "failed", note: `Claude error: ${errMsg}` }, now);
    return { ok: false, error: errMsg };
  }

  // ── 8. Check for SPAWN_TASKS block ──────────────────────────────────────────
  const spawnMatch = finalText.match(/<SPAWN_TASKS>\s*([\s\S]*?)\s*<\/SPAWN_TASKS>/);
  const spawnJson = spawnMatch?.[1];
  if (spawnMatch && spawnJson) {
    try {
      const spawnList = JSON.parse(spawnJson) as Array<{
        kind: string;
        summary: string;
        details?: string;
      }>;

      const childIds: string[] = [];
      for (const spawn of spawnList) {
        const childId = crypto.randomUUID();
        const route = await routeTask(db, spawn.kind, null);
        await run(
          db,
          `INSERT INTO tasks (id, kind, status, parent_task_id, assigned_agent_id, team_id, input, created_at, updated_at)
           VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
          [
            childId,
            spawn.kind,
            taskId,
            route.agentId ?? null,
            route.teamId ?? null,
            JSON.stringify({ summary: spawn.summary, details: spawn.details ?? "" }),
            now,
            now,
          ],
        );
        childIds.push(childId);
      }

      // Transition parent → waiting_children
      const waitingOutput = JSON.stringify({ pendingChildren: childIds, spawnedAt: now });
      await run(
        db,
        "UPDATE tasks SET status='waiting_children', output=?, updated_at=? WHERE id=?",
        [waitingOutput, now, taskId],
      );
      await emitEvent(db, taskId, {
        from: "running",
        to: "waiting_children",
        note: `spawned ${childIds.length} sub-tasks`,
        childIds,
        toolCallLog,
      }, now);

      return { ok: true, spawned: true, output: `Spawned ${childIds.length} children: ${childIds.join(", ")}` };
    } catch (parseErr: unknown) {
      // Bad JSON in spawn block — fall through to normal completion
      console.error("[executor] failed to parse SPAWN_TASKS:", parseErr);
    }
  }

  // ── 9. Store artifact ───────────────────────────────────────────────────────
  const artifactContent = JSON.stringify({
    response: finalText,
    toolCallLog,
    iterations,
    childResults: childResultsText || undefined,
  });

  const artifactId = crypto.randomUUID();
  await run(
    db,
    `INSERT INTO artifacts (id, kind, name, url, content, task_id, created_at, updated_at)
     VALUES (?, 'log', ?, '', ?, ?, ?, ?)`,
    [artifactId, `${taskId}-output`, artifactContent, taskId, now, now],
  );

  // ── 10. Mark completed ──────────────────────────────────────────────────────
  const outputJson = JSON.stringify({
    summary: finalText.slice(0, 200),
    artifactIds: [artifactId],
    toolsUsed: toolCallLog.map((t) => t.name),
  });
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
    toolsUsed: toolCallLog.map((t) => t.name),
    iterations,
  }, now);

  return { ok: true, output: finalText, artifactId };
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
