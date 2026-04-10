import { AutoRouter, cors, type IRequest } from "itty-router";
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
import { scheduledHandler } from "./scheduled";
export { AgentActor } from "./actors/AgentActor";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  ANTHROPIC_API_KEY: string;
  BRAVE_SEARCH_API_KEY?: string;
  SEARXNG_BASE_URL?: string;
  AGENT_ACTOR: DurableObjectNamespace;
  AI: Ai; // Cloudflare Workers AI — used for Whisper voice transcription
  OPENROUTER_API_KEY?: string;
  GITHUB_TOKEN?: string;
}

const { preflight, corsify } = cors({ origin: "*" });

const router = AutoRouter<IRequest, [Env, ExecutionContext]>({
  before: [preflight],
  finally: [corsify],
});

router.get("/health", () => Response.json({ status: "ok" }));

router.all("/api/agents/*", agentsRouter.fetch);
router.all("/api/teams/*", teamsRouter.fetch);
router.all("/api/tasks/*", tasksRouter.fetch);
router.all("/api/approvals/*", approvalsRouter.fetch);
router.all("/api/proposals/*", proposalsRouter.fetch);
router.all("/api/events/*", eventsRouter.fetch);
router.all("/api/artifacts/*", artifactsRouter.fetch);
router.all("/api/tools/*", toolsRouter.fetch);
router.get("/api/graph", graphHandler);
router.get("/api/stats", statsHandler);
router.all("/api/actors/*", actorRouter.fetch);
router.all("/api/graphs/*", graphsRouter.fetch);
router.all("/api/intake/*", intakeRouter.fetch);
router.all("/api/nation/*", nationRouter.fetch);
router.all("/telegram/*", telegramRouter.fetch);
router.all("/api/supervisor/*", supervisorRouter.fetch);
router.all("/api/retell/*", retellRouter.fetch);
router.all("/api/bailey/*", baileyRouter.fetch);

export default {
  fetch: router.fetch,
  scheduled: scheduledHandler,
} satisfies ExportedHandler<Env>;