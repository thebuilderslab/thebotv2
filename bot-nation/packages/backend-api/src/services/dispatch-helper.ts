/**
 * Dispatch Helper
 *
 * Reusable function to take a free-text user message and dispatch it as a
 * D1 task + immediate AgentActor invocation. Used by:
 *   - routes/telegram.ts (primary inbound path)
 *   - scheduled.ts (supervisor reminder auto-answers unanswered queries)
 */

import type { Env } from "../index";
import { run } from "../db/schema";
import { classifyQuery } from "./query-classifier";
import { persistTelegramMessage } from "./nation-supervisor";

const AGENT_MAP: Record<string, string> = {
  "team-finance":  "agent-finance-lead",
  "team-research": "agent-research-lead",
  "team-intel":    "agent-intel-lead",
  "team-build":    "agent-build-lead",
  "team-growth":   "agent-growth-lead",
  "team-infra":    "agent-infra-lead",
  "team-bailey":   "agent-bailey-lead",
  "team-agency":   "agent-agency-growthops",
  "team-p87":      "agent-p87-planner",
};

export interface DispatchResult {
  ok: boolean;
  taskId?: string;
  agentId?: string;
  reason?: string;
}

/**
 * Returns ok:false (with reason) for non-actionable / trivial replies so callers
 * can skip them without polluting the task table.
 */
export async function dispatchTextAsTask(
  env: Env,
  chatId: number | string,
  text: string,
  options: { userId?: number | string; sendAck?: boolean; sourceLabel?: string } = {},
): Promise<DispatchResult> {
  const trimmed = text.trim();

  // Skip trivial replies that gap-detection picks up but aren't real queries
  if (trimmed.length < 6) return { ok: false, reason: "too_short" };
  if (/^(yeah|yep|yes|y|no|n|ok|okay|k|sure|thanks|thx|ty|cool|nice)\b/i.test(trimmed)) {
    return { ok: false, reason: "trivial_reply" };
  }

  const classification = classifyQuery(trimmed);
  if (classification.type !== "action") {
    return { ok: false, reason: `not_action_(${classification.type})` };
  }

  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();
  const teamId = classification.suggestedTeam ?? "team-research";
  const kind = classification.suggestedTaskKind ?? "research";
  const agentId = AGENT_MAP[teamId] ?? "agent-research-lead";

  let taskDetails = "";
  if (kind === "code_change") {
    taskDetails = `You are agent-build-lead. OPERATOR REQUEST: "${trimmed}"

You MUST call the tools below in order. Do NOT describe what you will do — execute it.

STEP 1 — CALL read_github_file
Choose the most relevant file. Paths MUST start with "bot-nation/" — that is the repo layout.
  • Morning brief / scheduled output → bot-nation/packages/backend-api/src/scheduled.ts
  • Telegram routing, formatting, buttons → bot-nation/packages/backend-api/src/routes/telegram.ts
  • Agent behavior, system prompt → bot-nation/packages/backend-api/src/actors/AgentActor.ts
  • Query classifier / team routing → bot-nation/packages/backend-api/src/services/query-classifier.ts
Call: read_github_file({ path: "<chosen file>" })

STEP 2 — LOCATE THE CHANGE
STEP 3 — GENERATE MODIFIED FILE (full file, not a diff)
STEP 4 — CALL submit_code_change with { files, commit_message, change_summary }`;
  }

  await run(
    env.DB,
    `INSERT INTO tasks (id, kind, status, assigned_agent_id, team_id, input, telegram_chat_id, started_at, created_at, updated_at)
     VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
    [taskId, kind, agentId, teamId, JSON.stringify({ summary: trimmed, details: taskDetails }), String(chatId), now, now, now],
  );

  void persistTelegramMessage(env.DB, "in", chatId, trimmed, {
    userId: options.userId,
    taskId,
    routeType: options.sourceLabel ?? "action",
    agentId,
  });

  if (options.sendAck !== false) {
    const ackText = `🔄 <b>On it</b> — routing to ${agentId}\n<code>${taskId}</code>`;
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: ackText, parse_mode: "HTML" }),
      signal: AbortSignal.timeout(5_000),
    });
    void persistTelegramMessage(env.DB, "out", chatId, ackText, {
      taskId,
      routeType: options.sourceLabel ?? "action",
      agentId,
    });
  }

  await run(
    env.DB,
    `INSERT INTO events (id, kind, actor_id, target_kind, target_id, payload, session_id, created_at, updated_at)
     VALUES (?, 'task.created', NULL, 'task', ?, ?, NULL, ?, ?)`,
    [
      crypto.randomUUID(),
      taskId,
      JSON.stringify({ source: options.sourceLabel ?? "telegram_message", chatId, text: trimmed.slice(0, 200) }),
      now,
      now,
    ],
  );

  // Immediate DO dispatch
  try {
    const sessionId = crypto.randomUUID();
    await run(
      env.DB,
      `INSERT INTO agent_sessions (id, agent_id, task_id, status, ws_connected, started_at, updated_at)
       VALUES (?, ?, ?, 'running', 0, ?, ?)`,
      [sessionId, agentId, taskId, now, now],
    );
    await run(
      env.DB,
      `INSERT INTO events (id, kind, actor_id, target_kind, target_id, payload, session_id, created_at, updated_at)
       VALUES (?, 'task.status_changed', ?, 'task', ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        agentId,
        taskId,
        JSON.stringify({ from: "pending", to: "running", note: `dispatched immediately from ${options.sourceLabel ?? "telegram"}` }),
        sessionId,
        now,
        now,
      ],
    );
    const doId = env.AGENT_ACTOR.idFromName(agentId);
    const stub = env.AGENT_ACTOR.get(doId);
    await stub.fetch("https://do/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, sessionId }),
    });
  } catch (err) {
    console.error(`[dispatchTextAsTask] DO dispatch failed for ${taskId}:`, err);
  }

  return { ok: true, taskId, agentId };
}
