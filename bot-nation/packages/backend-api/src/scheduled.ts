/**
 * Cloudflare cron handler — Task Dispatcher
 *
 * Runs every 5 minutes (configured in wrangler.jsonc).
 *
 * Phase 2 responsibilities:
 *   1. Route any pending tasks that still lack a team/agent assignment
 *   2. Transition assigned pending tasks → running (dispatch signal)
 *   3. Time out running tasks older than 10 minutes → failed
 *
 * Phase 4 will add actual LLM execution inside step 2.
 */

import type { Env } from "./index";
import { query, run } from "./db/schema";
import { routeTask } from "./services/task-router";

const DISPATCH_LIMIT = 10;        // max tasks to dispatch per cron tick
const TIMEOUT_MINUTES = 10;       // running tasks older than this → failed

interface PendingTask {
  id: string;
  kind: string;
  team_id: string | null;
  assigned_agent_id: string | null;
  created_at: string;
}

interface RunningTask {
  id: string;
  updated_at: string;
}

export async function scheduledHandler(
  _controller: ScheduledController,
  env: Env,
  _ctx: ExecutionContext,
): Promise<void> {
  const now = new Date().toISOString();

  // ── 1. Route unassigned pending tasks ─────────────────────────────────────
  const unrouted = await query<PendingTask>(
    env.DB,
    "SELECT id, kind, team_id, assigned_agent_id FROM tasks WHERE status = 'pending' AND assigned_agent_id IS NULL LIMIT ?",
    [DISPATCH_LIMIT],
  );

  for (const task of unrouted) {
    const route = await routeTask(env.DB, task.kind, task.team_id);
    if (route.agentId || route.teamId) {
      await run(
        env.DB,
        "UPDATE tasks SET assigned_agent_id=?, team_id=?, updated_at=? WHERE id=?",
        [route.agentId, route.teamId, now, task.id],
      );
      await emitEvent(env.DB, "task.status_changed", null, "task", task.id, {
        note: "auto-routed by scheduler",
        assignedAgentId: route.agentId,
        teamId: route.teamId,
      }, null, now);
    }
  }

  // ── 2. Dispatch: pending + assigned → running ──────────────────────────────
  const pending = await query<PendingTask>(
    env.DB,
    "SELECT id, kind, team_id, assigned_agent_id FROM tasks WHERE status = 'pending' AND assigned_agent_id IS NOT NULL LIMIT ?",
    [DISPATCH_LIMIT],
  );

  for (const task of pending) {
    await run(
      env.DB,
      "UPDATE tasks SET status='running', updated_at=? WHERE id=?",
      [now, task.id],
    );
    await emitEvent(env.DB, "task.status_changed", task.assigned_agent_id, "task", task.id, {
      from: "pending",
      to: "running",
      note: "dispatched by cron scheduler",
    }, null, now);
  }

  // ── 3. Time out stale running tasks ───────────────────────────────────────
  const cutoff = new Date(Date.now() - TIMEOUT_MINUTES * 60 * 1000).toISOString();
  const stale = await query<RunningTask>(
    env.DB,
    "SELECT id, updated_at FROM tasks WHERE status = 'running' AND updated_at < ?",
    [cutoff],
  );

  for (const task of stale) {
    await run(
      env.DB,
      "UPDATE tasks SET status='failed', updated_at=? WHERE id=?",
      [now, task.id],
    );
    await emitEvent(env.DB, "task.status_changed", null, "task", task.id, {
      from: "running",
      to: "failed",
      note: `timed out after ${TIMEOUT_MINUTES} minutes`,
      lastUpdatedAt: task.updated_at,
    }, null, now);
  }
}

// ── helper: emit event row ─────────────────────────────────────────────────

async function emitEvent(
  db: D1Database,
  kind: string,
  actorId: string | null,
  targetKind: string,
  targetId: string,
  payload: Record<string, unknown>,
  sessionId: string | null,
  now: string,
): Promise<void> {
  const id = crypto.randomUUID();
  await run(
    db,
    `INSERT INTO events (id, kind, actor_id, target_kind, target_id, payload, session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, kind, actorId ?? null, targetKind, targetId, JSON.stringify(payload), sessionId ?? null, now, now],
  );
}
