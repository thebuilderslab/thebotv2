import { AutoRouter, type IRequest } from "itty-router";
import type { Env } from "../index";
import { query, queryOne } from "../db/schema";

export const eventsRouter = AutoRouter<IRequest, [Env, ExecutionContext]>();

// ─── GET /api/events ─────────────────────────────────────────────────────────
// Optional: ?kind=proposal.applied  ?targetId=<uuid>

eventsRouter.get("/api/events", async (req, env) => {
  const rawKind = req.query["kind"];
  const rawTargetId = req.query["targetId"];
  const kind = Array.isArray(rawKind) ? rawKind[0] : rawKind;
  const targetId = Array.isArray(rawTargetId) ? rawTargetId[0] : rawTargetId;

  let sql = "SELECT * FROM events";
  const params: string[] = [];
  const conditions: string[] = [];

  if (kind) {
    conditions.push("kind = ?");
    params.push(kind);
  }
  if (targetId) {
    conditions.push("target_id = ?");
    params.push(targetId);
  }
  if (conditions.length > 0) {
    sql += " WHERE " + conditions.join(" AND ");
  }
  sql += " ORDER BY created_at DESC LIMIT 200";

  const rows = await query(env.DB, sql, params);
  return Response.json(rows);
});

// ─── GET /api/events/:id ─────────────────────────────────────────────────────

eventsRouter.get("/api/events/:id", async (req, env) => {
  const id = req.params["id"];
  if (!id) return new Response("Bad Request", { status: 400 });
  const event = await queryOne(env.DB, "SELECT * FROM events WHERE id = ?", [id]);
  if (!event) return new Response("Not found", { status: 404 });
  return Response.json(event);
});
