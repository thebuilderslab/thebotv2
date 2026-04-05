# Run from: C:\Users\janin\thebotv2\thebotv2\bot-nation
# Creates all source files for core-domain and backend-api

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-File($path, $content) {
    $full = Join-Path $root $path
    $dir = Split-Path $full
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($full, $content, [System.Text.Encoding]::UTF8)
    Write-Host "  wrote $path"
}

Write-Host "`n== core-domain ==" -ForegroundColor Cyan

Write-File "packages\core-domain\package.json" @'
{
  "name": "@bot-nation/core-domain",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^6.0.2"
  }
}
'@

Write-File "packages\core-domain\src\common.ts" @'
export type ID = string;

export type Timestamp = string; // ISO 8601

export interface WithMeta {
  id: ID;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
'@

Write-File "packages\core-domain\src\agent.ts" @'
import { WithMeta, ID } from "./common";

export type AgentRole =
  | "governor"
  | "team_lead"
  | "worker"
  | "inspector"
  | "finance_specialist"
  | "infra_specialist"
  | "researcher"
  | "designer"
  | "growth";

export type AgentDomain =
  | "governance"
  | "orchestration"
  | "code_safety"
  | "product"
  | "growth"
  | "infra"
  | "blockchain_sim"
  | "other";

export interface AgentTrait {
  name: string;
  value: number;
}

export interface AgentCapability {
  toolId: ID;
  scope: "read" | "write" | "execute" | "admin";
}

export interface Agent extends WithMeta {
  name: string;
  role: AgentRole;
  domain: AgentDomain;
  teamId: ID | null;
  traits: AgentTrait[];
  capabilities: AgentCapability[];
  active: boolean;
  description?: string;
}
'@

Write-File "packages\core-domain\src\team.ts" @'
import { WithMeta, ID } from "./common";

export type TeamDomain =
  | "governance"
  | "orchestration"
  | "knowledge"
  | "execution_finance"
  | "execution_product"
  | "execution_growth"
  | "execution_infra";

export interface Team extends WithMeta {
  name: string;
  domain: TeamDomain;
  leadAgentId: ID | null;
  memberIds: ID[];
  description?: string;
}
'@

Write-File "packages\core-domain\src\task.ts" @'
import { WithMeta, ID } from "./common";

export type TaskStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "approved"
  | "rejected"
  | "completed"
  | "failed";

export type TaskKind =
  | "improvement_proposal"
  | "code_change"
  | "config_change"
  | "wallet_simulation"
  | "content_generation"
  | "research"
  | "other";

export interface TaskInput {
  summary: string;
  details?: string;
  relatedAgentIds?: ID[];
  relatedTeamIds?: ID[];
  relatedArtifactIds?: ID[];
}

export interface TaskOutput {
  summary?: string;
  artifactIds?: ID[];
  logUrl?: string;
}

export interface Task extends WithMeta {
  kind: TaskKind;
  status: TaskStatus;
  createdByAgentId: ID | null;
  assignedAgentId: ID | null;
  input: TaskInput;
  output?: TaskOutput;
  approvalId?: ID;
}
'@

Write-File "packages\core-domain\src\artifact.ts" @'
import { WithMeta, ID } from "./common";

export type ArtifactKind =
  | "code_diff"
  | "config_patch"
  | "test_report"
  | "simulation_report"
  | "design_doc"
  | "log"
  | "other";

export interface Artifact extends WithMeta {
  kind: ArtifactKind;
  name: string;
  url: string;
  taskId: ID | null;
  relatedAgentIds?: ID[];
}
'@

Write-File "packages\core-domain\src\policy.ts" @'
import { WithMeta } from "./common";
import { TaskKind } from "./task";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ChangePolicyRule {
  name: string;
  appliesToKinds: TaskKind[];
  maxRisk: RiskLevel;
  requiresHumanApproval: boolean;
  minApproverRole: "team_lead" | "governor";
  notes?: string;
}

export interface Policy extends WithMeta {
  name: string;
  description?: string;
  rules: ChangePolicyRule[];
}
'@

Write-File "packages\core-domain\src\approval.ts" @'
import { WithMeta, ID, Timestamp } from "./common";
import { RiskLevel } from "./policy";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export type ApprovalChannel = "telegram" | "dashboard" | "api";

export interface ApprovalBrief {
  title: string;
  summary: string;
  risk: RiskLevel;
  expectedBenefit: string;
  blastRadius: string;
}

export interface ApprovalDecision {
  status: ApprovalStatus;
  decidedByUserId: ID;
  decidedAt: Timestamp;
  channel: ApprovalChannel;
  rationale?: string;
}

export interface Approval extends WithMeta {
  taskId: ID;
  requestedByAgentId: ID | null;
  brief: ApprovalBrief;
  status: ApprovalStatus;
  decisions: ApprovalDecision[];
}
'@

Write-File "packages\core-domain\src\index.ts" @'
export * from "./common";
export * from "./agent";
export * from "./team";
export * from "./task";
export * from "./artifact";
export * from "./policy";
export * from "./approval";
'@

Write-Host "`n== backend-api ==" -ForegroundColor Cyan

Write-File "packages\backend-api\package.json" @'
{
  "name": "@bot-nation/backend-api",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "typecheck": "tsc --noEmit",
    "db:migrate:local": "wrangler d1 migrations apply bot-nation-db --local",
    "db:migrate:remote": "wrangler d1 migrations apply bot-nation-db --remote"
  },
  "dependencies": {
    "@bot-nation/core-domain": "workspace:*",
    "itty-router": "^5.0.18"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20250401.0",
    "typescript": "^6.0.2",
    "wrangler": "^4.0.0"
  }
}
'@

Write-File "packages\backend-api\tsconfig.json" @'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
'@

Write-File "packages\backend-api\wrangler.jsonc" @'
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "bot-nation-api",
  "main": "src/index.ts",
  "compatibility_date": "2025-05-06",
  "compatibility_flags": ["nodejs_compat"],
  "observability": { "enabled": true },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "pbot-nation-db",
      "database_id": "53800135-51c4-459f-837e-2606b4431762",
      "migrations_dir": "migrations"
    }
  ]
}
'@

Write-File "packages\backend-api\src\index.ts" @'
import { AutoRouter, cors } from "itty-router";
import { agentsRouter } from "./routes/agents";
import { teamsRouter } from "./routes/teams";
import { tasksRouter } from "./routes/tasks";
import { approvalsRouter } from "./routes/approvals";
import { telegramRouter } from "./routes/telegram";

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
router.all("/telegram/*", telegramRouter.fetch);

export default {
  fetch: router.fetch,
} satisfies ExportedHandler<Env>;
'@

Write-File "packages\backend-api\src\db\schema.ts" @'
export async function query<T>(
  db: D1Database,
  sql: string,
  params: (string | number | null)[] = []
): Promise<T[]> {
  const result = await db.prepare(sql).bind(...params).all<T>();
  return result.results;
}

export async function queryOne<T>(
  db: D1Database,
  sql: string,
  params: (string | number | null)[] = []
): Promise<T | null> {
  const result = await db.prepare(sql).bind(...params).first<T>();
  return result ?? null;
}

export async function run(
  db: D1Database,
  sql: string,
  params: (string | number | null)[] = []
): Promise<D1Result> {
  return db.prepare(sql).bind(...params).run();
}
'@

Write-File "packages\backend-api\src\routes\agents.ts" @'
import { AutoRouter } from "itty-router";
import type { Env } from "../index";
import { query, queryOne, run } from "../db/schema";
import type { Agent } from "@bot-nation/core-domain";

export const agentsRouter = AutoRouter<Request, [Env, ExecutionContext]>();

agentsRouter.get("/api/agents", async (_req, env) => {
  const rows = await query<Agent>(env.DB, "SELECT * FROM agents ORDER BY created_at DESC");
  return Response.json(rows);
});

agentsRouter.get("/api/agents/:id", async (req, env) => {
  const agent = await queryOne<Agent>(env.DB, "SELECT * FROM agents WHERE id = ?", [req.params.id]);
  if (!agent) return new Response("Not found", { status: 404 });
  return Response.json(agent);
});

agentsRouter.post("/api/agents", async (req, env) => {
  const body = await req.json<Omit<Agent, "id" | "createdAt" | "updatedAt">>();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await run(
    env.DB,
    `INSERT INTO agents (id, name, role, domain, team_id, traits, capabilities, active, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, body.name, body.role, body.domain, body.teamId ?? null,
     JSON.stringify(body.traits ?? []), JSON.stringify(body.capabilities ?? []),
     body.active ? 1 : 0, body.description ?? null, now, now]
  );
  return Response.json({ id }, { status: 201 });
});

agentsRouter.patch("/api/agents/:id", async (req, env) => {
  const body = await req.json<Partial<Agent>>();
  const now = new Date().toISOString();
  await run(
    env.DB,
    `UPDATE agents SET name=COALESCE(?,name), role=COALESCE(?,role), domain=COALESCE(?,domain),
     active=COALESCE(?,active), description=COALESCE(?,description), updated_at=? WHERE id=?`,
    [body.name ?? null, body.role ?? null, body.domain ?? null,
     body.active !== undefined ? (body.active ? 1 : 0) : null,
     body.description ?? null, now, req.params.id]
  );
  return Response.json({ ok: true });
});
'@

Write-File "packages\backend-api\src\routes\teams.ts" @'
import { AutoRouter } from "itty-router";
import type { Env } from "../index";
import { query, queryOne, run } from "../db/schema";
import type { Team } from "@bot-nation/core-domain";

export const teamsRouter = AutoRouter<Request, [Env, ExecutionContext]>();

teamsRouter.get("/api/teams", async (_req, env) => {
  const rows = await query<Team>(env.DB, "SELECT * FROM teams ORDER BY created_at DESC");
  return Response.json(rows);
});

teamsRouter.get("/api/teams/:id", async (req, env) => {
  const team = await queryOne<Team>(env.DB, "SELECT * FROM teams WHERE id = ?", [req.params.id]);
  if (!team) return new Response("Not found", { status: 404 });
  return Response.json(team);
});

teamsRouter.post("/api/teams", async (req, env) => {
  const body = await req.json<Omit<Team, "id" | "createdAt" | "updatedAt">>();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await run(
    env.DB,
    `INSERT INTO teams (id, name, domain, lead_agent_id, member_ids, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, body.name, body.domain, body.leadAgentId ?? null,
     JSON.stringify(body.memberIds ?? []), body.description ?? null, now, now]
  );
  return Response.json({ id }, { status: 201 });
});
'@

Write-File "packages\backend-api\src\routes\tasks.ts" @'
import { AutoRouter } from "itty-router";
import type { Env } from "../index";
import { query, queryOne, run } from "../db/schema";
import type { Task } from "@bot-nation/core-domain";

export const tasksRouter = AutoRouter<Request, [Env, ExecutionContext]>();

tasksRouter.get("/api/tasks", async (_req, env) => {
  const rows = await query<Task>(env.DB, "SELECT * FROM tasks ORDER BY created_at DESC");
  return Response.json(rows);
});

tasksRouter.get("/api/tasks/:id", async (req, env) => {
  const task = await queryOne<Task>(env.DB, "SELECT * FROM tasks WHERE id = ?", [req.params.id]);
  if (!task) return new Response("Not found", { status: 404 });
  return Response.json(task);
});

tasksRouter.post("/api/tasks", async (req, env) => {
  const body = await req.json<Omit<Task, "id" | "createdAt" | "updatedAt" | "status">>();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await run(
    env.DB,
    `INSERT INTO tasks (id, kind, status, created_by_agent_id, assigned_agent_id, input, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [id, body.kind, body.createdByAgentId ?? null,
     body.assignedAgentId ?? null, JSON.stringify(body.input), now, now]
  );
  return Response.json({ id }, { status: 201 });
});

tasksRouter.patch("/api/tasks/:id/status", async (req, env) => {
  const { status } = await req.json<{ status: Task["status"] }>();
  const now = new Date().toISOString();
  await run(env.DB, "UPDATE tasks SET status=?, updated_at=? WHERE id=?",
    [status, now, req.params.id]);
  return Response.json({ ok: true });
});
'@

Write-File "packages\backend-api\src\routes\approvals.ts" @'
import { AutoRouter } from "itty-router";
import type { Env } from "../index";
import { queryOne, run } from "../db/schema";
import type { Approval, ApprovalDecision } from "@bot-nation/core-domain";
import { sendApprovalToTelegram } from "./telegram";

export const approvalsRouter = AutoRouter<Request, [Env, ExecutionContext]>();

approvalsRouter.get("/api/approvals", async (_req, env) => {
  const result = await env.DB.prepare(
    "SELECT * FROM approvals ORDER BY created_at DESC"
  ).all<Approval>();
  return Response.json(result.results);
});

approvalsRouter.get("/api/approvals/:id", async (req, env) => {
  const approval = await queryOne<Approval>(env.DB,
    "SELECT * FROM approvals WHERE id = ?", [req.params.id]);
  if (!approval) return new Response("Not found", { status: 404 });
  return Response.json(approval);
});

approvalsRouter.post("/api/approvals", async (req, env) => {
  const body = await req.json<Omit<Approval, "id" | "createdAt" | "updatedAt" | "status" | "decisions">>();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await run(env.DB,
    `INSERT INTO approvals (id, task_id, requested_by_agent_id, brief, status, decisions, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', '[]', ?, ?)`,
    [id, body.taskId, body.requestedByAgentId ?? null, JSON.stringify(body.brief), now, now]
  );
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    await sendApprovalToTelegram(env, id, body.brief);
  }
  return Response.json({ id }, { status: 201 });
});

approvalsRouter.post("/api/approvals/:id/decision", async (req, env) => {
  const body = await req.json<{
    decision: "approved" | "rejected";
    userId: string;
    channel: ApprovalDecision["channel"];
    rationale?: string;
  }>();
  const approval = await queryOne<{ decisions: string; status: string }>(env.DB,
    "SELECT decisions, status FROM approvals WHERE id = ?", [req.params.id]);
  if (!approval) return new Response("Not found", { status: 404 });
  if (approval.status !== "pending") return Response.json({ error: "Already decided" }, { status: 409 });
  const decisions: ApprovalDecision[] = JSON.parse(approval.decisions);
  decisions.push({
    status: body.decision,
    decidedByUserId: body.userId,
    decidedAt: new Date().toISOString(),
    channel: body.channel,
    rationale: body.rationale,
  });
  const now = new Date().toISOString();
  await run(env.DB, "UPDATE approvals SET status=?, decisions=?, updated_at=? WHERE id=?",
    [body.decision, JSON.stringify(decisions), now, req.params.id]);
  await run(env.DB, "UPDATE tasks SET status=?, updated_at=? WHERE approval_id=?",
    [body.decision, now, req.params.id]);
  return Response.json({ ok: true });
});
'@

Write-File "packages\backend-api\src\routes\telegram.ts" @'
import { AutoRouter } from "itty-router";
import type { Env } from "../index";
import type { ApprovalBrief } from "@bot-nation/core-domain";

export const telegramRouter = AutoRouter<Request, [Env, ExecutionContext]>();

telegramRouter.post("/telegram/webhook", async (req, env) => {
  const update = await req.json<TelegramUpdate>();
  if (update.callback_query) {
    const { data } = update.callback_query;
    if (!data) return new Response("OK");
    const [, approvalId, decision] = data.split(":");
    if (!approvalId || !decision) return new Response("OK");
    if (decision !== "approved" && decision !== "rejected") return new Response("OK");
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE approvals SET status=?, updated_at=? WHERE id=?")
      .bind(decision, now, approvalId).run();
    await env.DB.prepare("UPDATE tasks SET status=?, updated_at=? WHERE approval_id=?")
      .bind(decision, now, approvalId).run();
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: update.callback_query.id, text: `Marked as ${decision}` }),
    });
  }
  return new Response("OK");
});

export async function sendApprovalToTelegram(env: Env, approvalId: string, brief: ApprovalBrief): Promise<void> {
  const emoji: Record<string, string> = { low: "🟢", medium: "🟡", high: "🔴", critical: "🚨" };
  const text =
    `*${brief.title}*\n\n${brief.summary}\n\n` +
    `${emoji[brief.risk] ?? "⚪"} Risk: *${brief.risk}*\n` +
    `💡 Benefit: ${brief.expectedBenefit}\n` +
    `💥 Blast radius: ${brief.blastRadius}`;
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "Approve", callback_data: `approval:${approvalId}:approved` },
          { text: "Reject", callback_data: `approval:${approvalId}:rejected` },
        ]],
      },
    }),
  });
}

interface TelegramUpdate {
  callback_query?: { id: string; from: { id: number }; data?: string };
}
'@

Write-File "packages\backend-api\migrations\0001_init.sql" @'
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  domain TEXT NOT NULL,
  team_id TEXT,
  traits TEXT NOT NULL DEFAULT "[]",
  capabilities TEXT NOT NULL DEFAULT "[]",
  active INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  lead_agent_id TEXT,
  member_ids TEXT NOT NULL DEFAULT "[]",
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT "pending",
  created_by_agent_id TEXT,
  assigned_agent_id TEXT,
  input TEXT NOT NULL DEFAULT "{}",
  output TEXT,
  approval_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  requested_by_agent_id TEXT,
  brief TEXT NOT NULL DEFAULT "{}",
  status TEXT NOT NULL DEFAULT "pending",
  decisions TEXT NOT NULL DEFAULT "[]",
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  task_id TEXT,
  related_agent_ids TEXT NOT NULL DEFAULT "[]",
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id);
'@

Write-Host "`n== All files written ==" -ForegroundColor Green
Write-Host "Next: cd packages\backend-api && pnpm install && npx wrangler deploy"
