/**
 * Cloudflare cron handler — Task Dispatcher
 *
 * Runs every 5 minutes (configured in wrangler.jsonc).
 *
 * Steps:
 *   1. Route unassigned pending tasks
 *   2. Dispatch assigned pending → running + execute via Claude
 *   2.5. Re-queue waiting_children parents whose children are all done
 *   3. Time out stale running tasks (10 min)
 *   4. Time out stuck waiting_children parents (60 min)
 */

import type { Env } from "./index";
import { query, queryOne, run } from "./db/schema";
import { routeTask } from "./services/task-router";

const DISPATCH_LIMIT = 10;
const TIMEOUT_MINUTES = 10;
const PARENT_TIMEOUT_MINUTES = 60;

interface PendingTask {
  id: string;
  kind: string;
  team_id: string | null;
  assigned_agent_id: string | null;
}

interface RunningTask {
  id: string;
  updated_at: string;
}

interface WaitingParent {
  id: string;
  updated_at: string;
}

export async function scheduledHandler(
  _controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const now = new Date().toISOString();

  // ── 1. Route unassigned pending tasks ───────────────────────────────────────
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

  // ── 2. Dispatch: pending + assigned → running ────────────────────────────────
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

    // Phase 6: dispatch to agent's Durable Object
    const sessionId = crypto.randomUUID();
    ctx.waitUntil((async () => {
      try {
        await run(
          env.DB,
          `INSERT INTO agent_sessions (id, agent_id, task_id, status, ws_connected, started_at, updated_at)
           VALUES (?, ?, ?, 'running', 0, ?, ?)`,
          [sessionId, task.assigned_agent_id ?? "", task.id, now, now],
        );
        const doId = env.AGENT_ACTOR.idFromName(task.assigned_agent_id ?? "");
        const stub = env.AGENT_ACTOR.get(doId);
        await stub.fetch("https://do/enqueue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ taskId: task.id, sessionId }),
        });
      } catch (err: unknown) {
        console.error(`[scheduler] DO dispatch failed for task ${task.id}:`, err);
      }
    })());
  }

  // ── 2.5. Re-queue waiting_children parents whose children are all done ────────
  const waitingParents = await query<WaitingParent>(
    env.DB,
    "SELECT id, updated_at FROM tasks WHERE status = 'waiting_children' LIMIT ?",
    [DISPATCH_LIMIT],
  );

  for (const parent of waitingParents) {
    const incomplete = await queryOne<{ c: number }>(
      env.DB,
      "SELECT COUNT(*) as c FROM tasks WHERE parent_task_id = ? AND status NOT IN ('completed','failed')",
      [parent.id],
    );

    if ((incomplete?.c ?? 1) === 0) {
      // All children done — re-queue parent as pending so it re-executes and synthesizes
      await run(
        env.DB,
        "UPDATE tasks SET status='pending', updated_at=? WHERE id=?",
        [now, parent.id],
      );
      await emitEvent(env.DB, "task.status_changed", null, "task", parent.id, {
        from: "waiting_children",
        to: "pending",
        note: "all children completed — re-queued for synthesis",
      }, null, now);
    }
  }

  // ── 3. Time out stale running tasks (10 min) ──────────────────────────────
  const runningCutoff = new Date(Date.now() - TIMEOUT_MINUTES * 60 * 1000).toISOString();
  const staleRunning = await query<RunningTask>(
    env.DB,
    "SELECT id, updated_at FROM tasks WHERE status = 'running' AND updated_at < ?",
    [runningCutoff],
  );

  for (const task of staleRunning) {
    await run(env.DB, "UPDATE tasks SET status='failed', updated_at=? WHERE id=?", [now, task.id]);
    await emitEvent(env.DB, "task.status_changed", null, "task", task.id, {
      from: "running", to: "failed",
      note: `timed out after ${TIMEOUT_MINUTES} minutes`,
      lastUpdatedAt: task.updated_at,
    }, null, now);
  }

  // ── 4. Time out stuck waiting_children parents (60 min) ───────────────────
  const parentCutoff = new Date(Date.now() - PARENT_TIMEOUT_MINUTES * 60 * 1000).toISOString();
  const staleParents = await query<RunningTask>(
    env.DB,
    "SELECT id, updated_at FROM tasks WHERE status = 'waiting_children' AND updated_at < ?",
    [parentCutoff],
  );

  for (const task of staleParents) {
    await run(env.DB, "UPDATE tasks SET status='failed', updated_at=? WHERE id=?", [now, task.id]);
    await emitEvent(env.DB, "task.status_changed", null, "task", task.id, {
      from: "waiting_children", to: "failed",
      note: `parent timed out after ${PARENT_TIMEOUT_MINUTES} minutes waiting for children`,
      lastUpdatedAt: task.updated_at,
    }, null, now);
  }
}

// ── helper: emit event row ────────────────────────────────────────────────────

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
