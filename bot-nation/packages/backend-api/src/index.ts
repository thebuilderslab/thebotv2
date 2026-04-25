import { Hono } from "hono";
import { cors } from "hono/cors";
import { agentsRouter } from "./routes/agents";
import { teamsRouter } from "./routes/teams";
import { tasksRouter } from "./routes/tasks";
import { approvalsRouter } from "./routes/approvals";
import { proposalsRouter } from "./routes/proposals";
import { eventsRouter } from "./routes/events";
import { telegramRouter } from "./routes/telegram";
import { intakeRouter } from "./routes/intake";
import { artifactsRouter } from "./routes/artifacts";
import { toolsRouter } from "./routes/tools";
import { graphHandler } from "./routes/graph";
import { statsHandler } from "./routes/stats";
import { actorRouter } from "./routes/actor";
import { graphsRouter } from "./routes/graphs";
import { nationRouter } from "./routes/nation";
import { supervisorRouter } from "./routes/supervisor-reminders";
import { retellRouter } from "./routes/retell";
import { baileyRouter } from "./routes/bailey";
import { propstreamRouter } from "./routes/propstream";
import { twsRouter } from "./routes/thinkorswim";
import { financeRouter } from "./routes/finance";
import { schwabRouter } from "./routes/schwab";
import { buildRouter } from "./routes/build";
import { scheduledHandler } from "./scheduled";
export { AgentActor } from "./actors/AgentActor";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  ANTHROPIC_API_KEY: string;
  BRAVE_SEARCH_API_KEY?: string;
  SEARXNG_BASE_URL?: string;
  LAST30DAYS_URL?: string;
  LAST30DAYS_API_KEY?: string;
  HERMES_API_URL?: string;
  TRADING_URL?: string;
  AGENT_ACTOR: DurableObjectNamespace;
  AI: Ai; // Cloudflare Workers AI — used for Whisper voice transcription
  OPENROUTER_API_KEY?: string;
  GITHUB_TOKEN?: string;
  DEPLOY_WEBHOOK_SECRET?: string;
  RETELL_API_KEY?: string;
  RETELL_AGENT_ID?: string;
  SCHWAB_CLIENT_ID?: string;
  SCHWAB_CLIENT_SECRET?: string;
}

const app = new Hono<{ Bindings: Env }>();

// CORS
app.use("*", cors({ origin: "*" }));

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Root
app.get("/", (c) => c.json({ service: "bot-nation-api" }));

// Debug: verify env bindings are accessible in Hono (remove after confirming)
app.get("/debug/env", (c) => c.json({
  has_db: !!c.env.DB,
  has_telegram: !!c.env.TELEGRAM_BOT_TOKEN,
  has_anthropic: !!c.env.ANTHROPIC_API_KEY,
  has_retell_key: !!c.env.RETELL_API_KEY,
  has_retell_agent: !!c.env.RETELL_AGENT_ID,
  retell_key_len: c.env.RETELL_API_KEY?.length ?? 0,
  retell_agent_len: c.env.RETELL_AGENT_ID?.length ?? 0,
  has_schwab_id: !!c.env.SCHWAB_CLIENT_ID,
  has_schwab_secret: !!c.env.SCHWAB_CLIENT_SECRET,
  schwab_id_len: c.env.SCHWAB_CLIENT_ID?.length ?? 0,
  schwab_secret_len: c.env.SCHWAB_CLIENT_SECRET?.length ?? 0,
  schwab_id_preview: c.env.SCHWAB_CLIENT_ID ? c.env.SCHWAB_CLIENT_ID.slice(0, 6) + "..." : null,
}));

// Telegram (Hono native)
app.route("/api", telegramRouter);

// thinkorswim Integration (Hono native — /api/tws/*)
app.route("/", twsRouter);

// Schwab OAuth (Hono native — /api/schwab/*)
app.route("/", schwabRouter);

// Build / self-modification pipeline (Hono native — /api/build/*)
app.route("/", buildRouter);

// Legacy itty-router routes (forwarded as middleware)
const legacyHandler = async (c: any) => {
  // c.req in Hono v4 is a HonoRequest wrapper — use c.req.raw for the native Request
  // that itty-router expects. c.env is the Cloudflare Workers env (DB, secrets, etc.).
  const raw: Request = c.req.raw ?? c.req;
  const { pathname } = new URL(raw.url);
  const env: Env = c.env;
  const ctx: ExecutionContext = c.executionCtx;

  // Dispatch to appropriate legacy router — pass env + ctx so handlers can access DB, secrets, etc.
  if (pathname.startsWith("/api/agents")) return agentsRouter.fetch(raw, env, ctx);
  if (pathname.startsWith("/api/teams")) return teamsRouter.fetch(raw, env, ctx);
  if (pathname.startsWith("/api/tasks")) return tasksRouter.fetch(raw, env, ctx);
  if (pathname.startsWith("/api/approvals")) return approvalsRouter.fetch(raw, env, ctx);
  if (pathname.startsWith("/api/proposals")) return proposalsRouter.fetch(raw, env, ctx);
  if (pathname.startsWith("/api/events")) return eventsRouter.fetch(raw, env, ctx);
  if (pathname.startsWith("/api/artifacts")) return artifactsRouter.fetch(raw, env, ctx);
  if (pathname.startsWith("/api/tools")) return toolsRouter.fetch(raw, env, ctx);
  if (pathname.startsWith("/api/actors")) return actorRouter.fetch(raw, env, ctx);
  if (pathname.startsWith("/api/graphs")) return graphsRouter.fetch(raw, env, ctx);
  if (pathname.startsWith("/api/intake")) return intakeRouter.fetch(raw, env, ctx);
  if (pathname.startsWith("/api/nation")) return nationRouter.fetch(raw, env, ctx);
  if (pathname.startsWith("/api/supervisor")) return supervisorRouter.fetch(raw, env, ctx);
  if (pathname.startsWith("/api/retell")) return retellRouter.fetch(raw, env, ctx);
  if (pathname.startsWith("/api/bailey")) return baileyRouter.fetch(raw, env, ctx);
  if (pathname.startsWith("/api/propstream")) return propstreamRouter.fetch(raw, env, ctx);
  if (pathname.startsWith("/api/finance")) return financeRouter.fetch(raw, env, ctx);
  if (pathname.startsWith("/api/build")) return buildRouter.fetch(raw, env, ctx);
  if (pathname === "/api/graph") return graphHandler(raw, env);
  if (pathname === "/api/stats") return statsHandler(raw, env);

  return c.json({ error: "not found" }, 404);
};

app.all("/api/*", legacyHandler);

// 404
app.notFound((c) => c.json({ error: "not found" }, 404));

// Error handler
app.onError((err, c) => {
  console.error("[Error]", err);
  return c.json({ error: err.message }, 500);
});

export default {
  fetch: app.fetch,
  scheduled: scheduledHandler,
} satisfies ExportedHandler<Env>;