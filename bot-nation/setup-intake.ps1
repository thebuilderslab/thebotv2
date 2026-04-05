$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-File($path, $content) {
    $full = Join-Path $root $path
    $dir = Split-Path $full
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($full, $content, [System.Text.Encoding]::UTF8)
    Write-Host "  wrote $path"
}

Write-Host "`n== Adding intake route ==" -ForegroundColor Cyan

Write-File "packages\backend-api\src\routes\intake.ts" @'
import { AutoRouter } from "itty-router";
import type { Env } from "../index";
import { run } from "../db/schema";
import { sendApprovalToTelegram } from "./telegram";

export const intakeRouter = AutoRouter<Request, [Env, ExecutionContext]>();

type LinkKind = "repo" | "package" | "docs" | "social" | "unknown";

function classifyUrl(url: string): LinkKind {
  if (/github\.com|gitlab\.com|bitbucket\.org/.test(url)) return "repo";
  if (/npmjs\.com|pypi\.org|crates\.io/.test(url)) return "package";
  if (/docs\.|readme\.|readthedocs\./.test(url)) return "docs";
  if (/twitter\.com|x\.com|linkedin\.com|reddit\.com/.test(url)) return "social";
  return "unknown";
}

intakeRouter.post("/api/intake", async (req, env) => {
  const { url, submittedBy } = await req.json<{ url: string; submittedBy?: string }>();

  if (!url) return Response.json({ error: "url is required" }, { status: 400 });

  const kind = classifyUrl(url);
  const now = new Date().toISOString();
  const taskId = crypto.randomUUID();
  const approvalId = crypto.randomUUID();

  // Create task
  await run(env.DB,
    `INSERT INTO tasks (id, kind, status, created_by_agent_id, assigned_agent_id, input, created_at, updated_at)
     VALUES (?, 'research', 'waiting_approval', NULL, NULL, ?, ?, ?)`,
    [taskId, JSON.stringify({ summary: `Assess ${kind}: ${url}`, details: url }), now, now]
  );

  // Create approval
  const brief = {
    title: `Intake Request: ${kind.toUpperCase()}`,
    summary: `A new ${kind} link has been submitted for assessment: ${url}`,
    risk: kind === "repo" || kind === "package" ? "medium" : "low" as const,
    expectedBenefit: "Expand bot-nation tooling and knowledge base",
    blastRadius: kind === "package" ? "Could add new dependency to system" : "Read-only assessment",
  };

  await run(env.DB,
    `INSERT INTO approvals (id, task_id, requested_by_agent_id, brief, status, decisions, created_at, updated_at)
     VALUES (?, ?, NULL, ?, 'pending', '[]', ?, ?)`,
    [approvalId, taskId, JSON.stringify(brief), now, now]
  );

  // Update task with approval id
  await run(env.DB, "UPDATE tasks SET approval_id = ? WHERE id = ?", [approvalId, taskId]);

  // Send to Telegram
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    await sendApprovalToTelegram(env, approvalId, brief);
  }

  return Response.json({ taskId, approvalId, kind, status: "pending_approval" }, { status: 201 });
});
'@

Write-Host "`n== Updating src\index.ts to include intake route ==" -ForegroundColor Cyan

Write-File "packages\backend-api\src\index.ts" @'
import { AutoRouter, cors } from "itty-router";
import { agentsRouter } from "./routes/agents";
import { teamsRouter } from "./routes/teams";
import { tasksRouter } from "./routes/tasks";
import { approvalsRouter } from "./routes/approvals";
import { telegramRouter } from "./routes/telegram";
import { intakeRouter } from "./routes/intake";

export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
}

const { preflight, corsify } = cors({ origin: "*" });

const router = AutoRouter<Request, [Env, ExecutionContext]>({
  before: [preflight],
  finally: [corsify],
});

router.get("/health", () => Response.json({ status: "ok" }));

router.all("/api/agents/*", agentsRouter.fetch);
router.all("/api/teams/*", teamsRouter.fetch);
router.all("/api/tasks/*", tasksRouter.fetch);
router.all("/api/approvals/*", approvalsRouter.fetch);
router.all("/api/intake/*", intakeRouter.fetch);
router.all("/telegram/*", telegramRouter.fetch);

export default {
  fetch: router.fetch,
} satisfies ExportedHandler<Env>;
'@

Write-Host "`n== Done. Now run: npx wrangler deploy ==" -ForegroundColor Green
