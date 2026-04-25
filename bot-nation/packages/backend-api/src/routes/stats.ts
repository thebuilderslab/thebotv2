/**
 * Stats endpoint — counts across all D1 tables.
 * Used by the Settings page to show live system state.
 */

import type { IRequest } from "itty-router";
import type { Env } from "../index";

interface CountRow { c: number }

async function count(db: D1Database, table: string): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) as c FROM ${table}`).first<CountRow>();
  return row?.c ?? 0;
}

export async function statsHandler(
  _req: IRequest,
  env: Env,
): Promise<Response> {
  const [agents, teams, tasks, proposals, approvals, events, artifacts, tools, notes] =
    await Promise.all([
      count(env.DB, "agents"),
      count(env.DB, "teams"),
      count(env.DB, "tasks"),
      count(env.DB, "proposals"),
      count(env.DB, "approvals"),
      count(env.DB, "events"),
      count(env.DB, "artifacts"),
      count(env.DB, "tools"),
      count(env.DB, "agent_notes"),
    ]);

  return Response.json({ agents, teams, tasks, proposals, approvals, events, artifacts, tools, notes });
}
