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
import { scheduledHandler } from "./scheduled";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
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
router.all("/api/intake/*", intakeRouter.fetch);
router.all("/telegram/*", telegramRouter.fetch);

export default {
  fetch: router.fetch,
  scheduled: scheduledHandler,
} satisfies ExportedHandler<Env>;