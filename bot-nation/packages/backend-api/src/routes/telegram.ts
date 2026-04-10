/**
 * Telegram Route — Phase 7B
 *
 * All inbound Telegram messages flow through Nation Supervisor.
 * Commands:
 *   /task <kind> <summary>  — create a task
 *   /status <taskId>        — check task status
 *   /approve <proposalId>   — approve a proposal
 *   /agents                 — list active agents
 *   /stats                  — system stats
 *   /teams                  — list teams/departments
 *   /help                   — show commands
 *
 * Callback queries handle approve/reject inline buttons on approval messages.
 */

import { AutoRouter } from "itty-router";
import type { Env } from "../index";
import type { ApprovalBrief } from "@bot-nation/core-domain";
import { applyChangeForApproval } from "../services/change-apply";
import { query, queryOne, run } from "../db/schema";
import { sanitiseInput } from "../services/guardrails";

// ── ETA estimates by task kind (seconds) ─────────────────────────────────────
const TASK_ETA_SECONDS: Record<string, number> = {
  research: 75, deep_research: 120, intel_review: 120,
  content_generation: 45, code_change: 60, improvement_proposal: 60,
  config_change: 45, wallet_simulation: 30, defi_plan: 90,
  defi_risk_check: 30, defi_health_monitor: 20, defi_report: 60,
  market_research: 60, campaign_generation: 30, lead_qualification: 45, crm_hygiene: 20,
};

function progressBar(filled: number, total: number, width = 10): string {
  const n = Math.min(Math.round((filled / Math.max(total, 1)) * width), width);
  return `[${"█".repeat(n)}${"░".repeat(width - n)}]`;
}

export const telegramRouter = AutoRouter();

// ── Valid task kinds ──────────────────────────────────────────────────────────

const TASK_KIND_ROUTING: Record<string, { teamId: string; agentId: string }> = {
  // Bot Nation core
  research:             { teamId: "team-research", agentId: "agent-research-lead" },
  deep_research:        { teamId: "team-research", agentId: "agent-research-lead" },
  content_generation:   { teamId: "team-growth",   agentId: "agent-growth-lead" },
  code_change:          { teamId: "team-build",     agentId: "agent-build-lead" },
  improvement_proposal: { teamId: "team-build",     agentId: "agent-build-lead" },
  config_change:        { teamId: "team-infra",     agentId: "agent-infra-lead" },
  wallet_simulation:    { teamId: "team-finance",   agentId: "agent-finance-lead" },
  // projecT87 DeFi
  defi_plan:            { teamId: "team-p87",       agentId: "agent-p87-planner" },
  defi_risk_check:      { teamId: "team-p87",       agentId: "agent-p87-risk" },
  defi_health_monitor:  { teamId: "team-p87",       agentId: "agent-p87-nurse" },
  defi_report:          { teamId: "team-p87",       agentId: "agent-p87-nurse" },
  // The Agency sales
  market_research:      { teamId: "team-agency",    agentId: "agent-agency-growthops" },
  campaign_generation:  { teamId: "team-agency",    agentId: "agent-agency-growthops" },
  lead_qualification:   { teamId: "team-agency",    agentId: "agent-agency-pipelineops" },
  crm_hygiene:          { teamId: "team-agency",    agentId: "agent-agency-revops" },
  // Intel — repo + link review
  intel_review:         { teamId: "team-intel",     agentId: "agent-intel-lead" },
};

// ── URL patterns that trigger automatic intel review ─────────────────────────
const INTEL_URL_PATTERN = /https?:\/\/(github\.com|gitlab\.com|bitbucket\.org|instagram\.com|twitter\.com|x\.com|ossinsight\.io)[^\s]*/gi;

// ── Main webhook handler ──────────────────────────────────────────────────────

telegramRouter.post("/telegram/webhook", async (req, env: Env) => {
  const update = (await req.json()) as TelegramUpdate;

  if (update.message) {
    const chatId = update.message.chat.id;

    // ── Guardrail: Sender authentication ─────────────────────────────────────
    console.log(`[Telegram] incoming chatId=${chatId} configured=${env.TELEGRAM_CHAT_ID}`);
    if (String(chatId) !== String(env.TELEGRAM_CHAT_ID)) {
      console.warn(`[Guardrail] Telegram message from unauthorised chat ${chatId} — dropped`);
      return new Response("OK");
    }

    // ── Voice note → transcribe → route as text ──────────────────────────────
    if (update.message.voice ?? update.message.audio) {
      await handleVoiceMessage(chatId, update.message, env);
      return new Response("OK");
    }

    const text = update.message.text?.trim() ?? "";

    if (!text.startsWith("/") && text.length > 0) {
      // ── Auto intel review: GitHub/social URLs sent as plain message ────────
      const urlMatches = text.match(INTEL_URL_PATTERN);
      if (urlMatches && urlMatches.length > 0) {
        await handleIntelReview(chatId, urlMatches, text, env);
      } else {
        // ── Natural language: route as research task ─────────────────────────
        await handleNaturalLanguageTask(chatId, text, env);
      }
      return new Response("OK");
    }

    await handleCommand(chatId, text, env);
    return new Response("OK");
  }

  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return new Response("OK");
  }

  return new Response("OK");
});

// ── Command dispatcher ────────────────────────────────────────────────────────

async function handleCommand(chatId: number, text: string, env: Env): Promise<void> {
  if (!text.startsWith("/")) return;

  const parts = text.split(/\s+/);
  // Strip @botname suffix from commands (e.g. /help@MyBot → /help)
  const cmd = (parts[0] ?? "").replace(/@\S+$/, "");
  const args = parts.slice(1);

  switch (cmd.toLowerCase()) {
    case "/start":
    case "/help":
      await sendMessage(env, chatId,
        `🤖 <b>Bot Nation — Nation Supervisor</b>\n\n` +
        `Available commands:\n` +
        `<code>/task &lt;kind&gt; &lt;summary&gt;</code> — spawn a task\n` +
        `<code>/status &lt;taskId&gt;</code> — check task status\n` +
        `<code>/approve &lt;proposalId&gt;</code> — approve a proposal\n` +
        `<code>/agents</code> — list active agents\n` +
        `<code>/teams</code> — list teams/departments\n` +
        `<code>/stats</code> — system overview\n\n` +
        `Task kinds: <code>research</code> · <code>deep_research</code> · <code>content_generation</code> · <code>code_change</code> · <code>improvement_proposal</code> · <code>config_change</code> · <code>wallet_simulation</code>`
      );
      break;

    case "/task":
      await handleTaskCommand(chatId, args, env);
      break;

    case "/status":
      await handleStatusCommand(chatId, args[0], env);
      break;

    case "/approve":
      await handleApproveCommand(chatId, args[0], env);
      break;

    case "/agents":
      await handleAgentsCommand(chatId, env);
      break;

    case "/teams":
      await handleTeamsCommand(chatId, env);
      break;

    case "/stats":
      await handleStatsCommand(chatId, env);
      break;

    case "/propose":
      await handleProposeCommand(chatId, args, env);
      break;

    case "/proposals":
      await handleProposalsCommand(chatId, env);
      break;

    case "/crons":
      await handleCronsCommand(chatId, env);
      break;

    default:
      await sendMessage(env, chatId, `Unknown command: <code>${cmd}</code>\nType /help for available commands.`);
  }
}

// ── /task <kind> <summary…> ───────────────────────────────────────────────────

async function handleTaskCommand(chatId: number, args: string[], env: Env): Promise<void> {
  if (args.length < 2) {
    await sendMessage(env, chatId,
      `Usage: <code>/task &lt;kind&gt; &lt;summary&gt;</code>\n\nExample:\n<code>/task research What is LangGraph?</code>`
    );
    return;
  }

  const kind = (args[0] ?? "").toLowerCase();
  const rawSummary = args.slice(1).join(" ");

  // Sanitise user input before storing or routing
  const { safe: summary, flagged, reasons } = sanitiseInput(rawSummary);
  if (flagged) {
    await sendMessage(env, chatId,
      `⚠️ Input contained restricted patterns and was sanitised:\n<code>${reasons.join("; ")}</code>`
    );
  }

  const routing = TASK_KIND_ROUTING[kind];
  if (!routing) {
    const kinds = Object.keys(TASK_KIND_ROUTING).join(" · ");
    await sendMessage(env, chatId, `Unknown task kind: <code>${kind}</code>\n\nValid kinds: ${kinds}`);
    return;
  }

  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();

  await run(env.DB,
    `INSERT INTO tasks (id, kind, status, assigned_agent_id, team_id, input, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [taskId, kind, routing.agentId, routing.teamId,
     JSON.stringify({ summary, source: "telegram" }), now, now],
  );

  // Emit event
  const eventId = crypto.randomUUID();
  await run(env.DB,
    `INSERT INTO events (id, kind, actor_id, target_kind, target_id, payload, created_at, updated_at)
     VALUES (?, 'task.created', 'agent-nation-supervisor', 'task', ?, ?, ?, ?)`,
    [eventId, taskId, JSON.stringify({ source: "telegram", chatId }), now, now],
  );

  // Send ETA message and store message_id for live progress editing
  const etaSeconds = TASK_ETA_SECONDS[kind] ?? 60;
  const etaText =
    `⏳ <b>${kind}</b> task queued\n` +
    `${progressBar(0, 10)} ETA ~${etaSeconds}s\n` +
    `Agent: <code>${routing.agentId}</code>\n` +
    `ID: <code>${taskId}</code>`;

  const tgRes = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: etaText, parse_mode: "Markdown" }),
    },
  );
  const tgData = await tgRes.json<{ ok: boolean; result?: { message_id: number } }>();
  if (tgData.ok && tgData.result?.message_id) {
    await run(env.DB,
      "UPDATE tasks SET telegram_chat_id=?, telegram_message_id=? WHERE id=?",
      [chatId, tgData.result.message_id, taskId],
    );
  }
}

// ── /status <taskId> ──────────────────────────────────────────────────────────

async function handleStatusCommand(chatId: number, taskId: string | undefined, env: Env): Promise<void> {
  if (!taskId) {
    await sendMessage(env, chatId, `Usage: <code>/status &lt;taskId&gt;</code>`);
    return;
  }

  const task = await queryOne<{
    id: string; kind: string; status: string; output: string | null;
    assigned_agent_id: string | null; created_at: string; updated_at: string;
  }>(env.DB, "SELECT id, kind, status, output, assigned_agent_id, created_at, updated_at FROM tasks WHERE id = ?", [taskId]);

  if (!task) {
    await sendMessage(env, chatId, `Task <code>${taskId}</code> not found.`);
    return;
  }

  const statusEmoji: Record<string, string> = {
    pending: "⏳", running: "⚙️", completed: "✅",
    failed: "❌", waiting_children: "🔀",
  };

  let outputText = "";
  if (task.status === "completed" && task.output) {
    try {
      const out = JSON.parse(task.output) as { summary?: string };
      outputText = `\n\n📝 <b>Summary:</b>\n${out.summary ?? "(no summary)"}`;
    } catch { /* ignore */ }
  }

  await sendMessage(env, chatId,
    `${statusEmoji[task.status] ?? "❓"} <b>Task Status</b>\n\n` +
    `ID: <code>${task.id}</code>\n` +
    `Kind: <code>${task.kind}</code>\n` +
    `Status: <code>${task.status}</code>\n` +
    `Agent: <code>${task.assigned_agent_id ?? "unassigned"}</code>\n` +
    `Updated: <code>${task.updated_at}</code>` +
    outputText
  );
}

// ── /approve <proposalId> ─────────────────────────────────────────────────────

async function handleApproveCommand(chatId: number, proposalId: string | undefined, env: Env): Promise<void> {
  if (!proposalId) {
    await sendMessage(env, chatId, `Usage: <code>/approve &lt;proposalId&gt;</code>`);
    return;
  }

  const proposal = await queryOne<{ id: string; title: string; status: string; type: string; cron_expression: string | null; task_kind: string | null }>(
    env.DB, "SELECT id, title, status, type, cron_expression, task_kind FROM proposals WHERE id = ?", [proposalId],
  );

  if (!proposal) {
    await sendMessage(env, chatId, `Proposal <code>${proposalId}</code> not found.`);
    return;
  }

  if (proposal.status !== "pending") {
    await sendMessage(env, chatId, `Proposal is already <code>${proposal.status}</code>.`);
    return;
  }

  const now = new Date().toISOString();
  await run(env.DB, "UPDATE proposals SET status='approved', approved_at=?, approved_by=? WHERE id=?",
    [now, String(chatId), proposalId]);

  // If cron_request: record in scheduled_crons (Claude will create actual cron)
  if (proposal.type === "cron_request" && proposal.cron_expression && proposal.task_kind) {
    const jobId = crypto.randomUUID();
    await run(env.DB,
      `INSERT INTO scheduled_crons (id, proposal_id, cron_job_id, status, created_at)
       VALUES (?, ?, ?, 'pending_creation', ?)`,
      [jobId, proposalId, "", now],
    );

    await sendMessage(env, chatId,
      `✅ <b>Cron Approved</b>\n\n` +
      `Task: <code>${proposal.task_kind}</code>\n` +
      `Schedule: <code>${proposal.cron_expression}</code>\n` +
      `Status: ⏳ Activating...\n\n` +
      `The system will create this cron shortly.\n` +
      `First run: Next scheduled time.`
    );
    return;
  }

  // Find linked approval and approve it too
  const approval = await queryOne<{ id: string }>(
    env.DB, "SELECT id FROM approvals WHERE proposal_id = ? AND status = 'pending'", [proposalId],
  );
  if (approval) {
    await run(env.DB, "UPDATE approvals SET status='approved', updated_at=? WHERE id=?", [now, approval.id]);
    await applyChangeForApproval(env.DB, approval.id, "telegram-operator", null);
  }

  await sendMessage(env, chatId,
    `✅ <b>Proposal approved</b>\n\n` +
    `ID: <code>${proposalId}</code>\n` +
    `Title: ${proposal.title}`
  );
}

// ── /agents ───────────────────────────────────────────────────────────────────

async function handleAgentsCommand(chatId: number, env: Env): Promise<void> {
  const agents = await query<{ id: string; name: string; role: string; domain: string }>(
    env.DB,
    "SELECT id, name, role, domain FROM agents WHERE status = 'active' ORDER BY domain, role",
    [],
  );

  if (agents.length === 0) {
    await sendMessage(env, chatId, "No active agents found.");
    return;
  }

  const domainEmoji: Record<string, string> = {
    governance: "🏛️", knowledge: "🔬", execution_product: "🛠️",
    execution_infra: "⚙️", execution_finance: "💰", execution_growth: "📈",
  };

  const lines = agents.map((a) =>
    `${domainEmoji[a.domain] ?? "•"} <b>${a.name}</b> (<code>${a.role}</code>) — <code>${a.id}</code>`
  );

  await sendMessage(env, chatId,
    `🤖 <b>Active Agents (${agents.length})</b>\n\n${lines.join("\n")}`
  );
}

// ── /teams ────────────────────────────────────────────────────────────────────

async function handleTeamsCommand(chatId: number, env: Env): Promise<void> {
  const rows = await query<{
    id: string;
    name: string;
    domain: string;
    lead_agent_id: string | null;
    objectives: string | null;
  }>(
    env.DB,
    "SELECT id, name, domain, lead_agent_id, objectives FROM teams ORDER BY name ASC",
    [],
  );

  if (rows.length === 0) {
    await sendMessage(env, chatId, "No teams found.");
    return;
  }

  const lines = rows.map((t) => {
    const lead = t.lead_agent_id ? `\nLead: <code>${t.lead_agent_id}</code>` : "";
    const objectives = t.objectives ? `\nObjective: ${t.objectives}` : "";
    return `• <b>${t.name}</b> <code>${t.id}</code>\nDomain: ${t.domain}${lead}${objectives}`;
  });

  const text =
    "🏢 <b>Teams / Departments</b>\n\n" +
    lines.join("\n\n");

  await sendMessage(env, chatId, text);
}

// ── /stats ────────────────────────────────────────────────────────────────────

async function handleStatsCommand(chatId: number, env: Env): Promise<void> {
  const [tasks, agents, proposals, events] = await Promise.all([
    queryOne<{ total: number; pending: number; running: number; completed: number; failed: number }>(
      env.DB,
      `SELECT COUNT(*) as total,
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as running,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed
       FROM tasks`, [],
    ),
    queryOne<{ count: number }>(env.DB, "SELECT COUNT(*) as count FROM agents WHERE status='active'", []),
    queryOne<{ count: number }>(env.DB, "SELECT COUNT(*) as count FROM proposals WHERE status='pending'", []),
    queryOne<{ count: number }>(env.DB, "SELECT COUNT(*) as count FROM events WHERE created_at > datetime('now','-1 hour')", []),
  ]);

  await sendMessage(env, chatId,
    `📊 <b>Bot Nation Stats</b>\n\n` +
    `<b>Tasks</b>\n` +
    `  Total: ${tasks?.total ?? 0} · Pending: ${tasks?.pending ?? 0} · Running: ${tasks?.running ?? 0}\n` +
    `  Completed: ${tasks?.completed ?? 0} · Failed: ${tasks?.failed ?? 0}\n\n` +
    `<b>System</b>\n` +
    `  Active agents: ${agents?.count ?? 0}\n` +
    `  Pending proposals: ${proposals?.count ?? 0}\n` +
    `  Events (last hour): ${events?.count ?? 0}`
  );
}

// ── Callback query handler (inline approve/reject buttons) ────────────────────

async function handleCallbackQuery(
  cbq: NonNullable<TelegramUpdate["callback_query"]>,
  env: Env,
): Promise<void> {
  const { data } = cbq;
  if (!data) return;

  const [, approvalId, decision] = data.split(":");
  if (!approvalId || !decision) return;
  if (decision !== "approved" && decision !== "rejected") return;

  const now = new Date().toISOString();

  await run(env.DB, "UPDATE approvals SET status=?, updated_at=? WHERE id=?", [decision, now, approvalId]);
  await run(env.DB, "UPDATE tasks SET status=?, updated_at=? WHERE approval_id=?", [decision, now, approvalId]);

  let applyNote = "";
  if (decision === "approved") {
    const result = await applyChangeForApproval(
      env.DB, approvalId, String(cbq.from.id), null,
    );
    applyNote = result.ok && result.appliedFields.length > 0
      ? ` · applied ${result.appliedFields.length} field(s)`
      : "";
  }

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      callback_query_id: cbq.id,
      text: `Marked as ${decision}${applyNote}`,
    }),
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sendMessage(env: Env, chatId: number, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[Telegram] sendMessage failed ${res.status}: ${body}`);
  }
}

// ── Approval push (called from scheduled.ts) ──────────────────────────────────

export async function sendApprovalToTelegram(
  env: Env,
  approvalId: string,
  brief: ApprovalBrief,
): Promise<void> {
  const emoji: Record<string, string> = {
    low: "🟢", medium: "🟡", high: "🔴", critical: "🚨",
  };

  const text =
    `<b>${brief.title}</b>\n\n${brief.summary}\n\n` +
    `${emoji[brief.risk] ?? "⚪"} Risk: <b>${brief.risk}</b>\n` +
    `💡 Benefit: ${brief.expectedBenefit}\n` +
    `💥 Blast radius: ${brief.blastRadius}`;

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: `approval:${approvalId}:approved` },
          { text: "❌ Reject",  callback_data: `approval:${approvalId}:rejected` },
        ]],
      },
    }),
  });
}

// ── Voice note handler ────────────────────────────────────────────────────────

async function handleVoiceMessage(
  chatId: number,
  message: NonNullable<TelegramUpdate["message"]>,
  env: Env,
): Promise<void> {
  const fileId = message.voice?.file_id ?? message.audio?.file_id;
  if (!fileId) return;

  await sendMessage(env, chatId, "🎙️ Voice note received — transcribing...");

  try {
    // 1. Get file download path from Telegram
    const fileRes = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`,
    );
    const fileData = await fileRes.json<{ ok: boolean; result: { file_path: string } }>();
    if (!fileData.ok) {
      await sendMessage(env, chatId, "❌ Failed to retrieve voice file from Telegram.");
      return;
    }

    // 2. Download the audio file (.ogg opus)
    const audioRes = await fetch(
      `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileData.result.file_path}`,
    );
    const audioBuffer = await audioRes.arrayBuffer();

    // 3. Transcribe via Cloudflare Workers AI (Whisper)
    let transcribedText = "";
    if (env.AI) {
      const result = await env.AI.run("@cf/openai/whisper", {
        audio: [...new Uint8Array(audioBuffer)],
      }) as { text?: string };
      transcribedText = result.text?.trim() ?? "";
    } else {
      await sendMessage(env, chatId, "⚠️ AI binding not configured — add `ai` binding to wrangler.jsonc");
      return;
    }

    if (!transcribedText) {
      await sendMessage(env, chatId, "❌ Could not transcribe audio — try speaking more clearly.");
      return;
    }

    await sendMessage(env, chatId, `📝 <b>Transcribed:</b> "${transcribedText}"`);

    // 4. Check for URLs in transcription → auto intel review
    const urlMatches = transcribedText.match(INTEL_URL_PATTERN);
    if (urlMatches && urlMatches.length > 0) {
      await handleIntelReview(chatId, urlMatches, transcribedText, env);
      return;
    }

    // 5. Route as a command if it starts with a slash word, else as research task
    const cleaned = transcribedText.trim();
    if (cleaned.startsWith("/") || cleaned.toLowerCase().startsWith("slash ")) {
      // Voice said a command — treat as text command
      const cmdText = cleaned.startsWith("/") ? cleaned : cleaned.replace(/^slash\s+/i, "/");
      await handleCommand(chatId, cmdText, env);
    } else {
      // Natural language voice note → route as research task to Nation Supervisor
      await handleNaturalLanguageTask(chatId, cleaned, env);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendMessage(env, chatId, `❌ Voice processing error: ${msg}`);
  }
}
// ── Brief parsing ─────────────────────────────────────────────────────────────

interface ParsedTask {
  summary: string;
}

interface ParsedBrief {
  intent: "brief";
  rawText: string;
  teamName?: string;
  goal?: string;
  mission?: string;
  expectedOutcome?: string;
  notes?: string;
  tasks: ParsedTask[];
}

function parseBrief(text: string): ParsedBrief {
  const raw = text.trim();
  const lines = raw.split(/\r?\n/);

  let currentSection: "team" | "goal" | "mission" | "expected" | "notes" | "tasks" | null = null;
  const brief: ParsedBrief = {
    intent: "brief",
    rawText: raw,
    tasks: [],
  };
  const notesLines: string[] = [];

  const sectionRegex = /^\s*(team|goal|mission|expected outcome|expected|notes|tasks)\s*:\s*(.*)$/i;

  for (const line of lines) {
    const m = line.match(sectionRegex);
    if (m) {
      const key = (m[1] ?? "").toLowerCase();
      const rest = (m[2] ?? "").trim();

      if (key === "team") {
        currentSection = "team";
        if (rest) brief.teamName = rest;
      } else if (key === "goal") {
        currentSection = "goal";
        if (rest) brief.goal = rest;
      } else if (key === "mission") {
        currentSection = "mission";
        if (rest) brief.mission = rest;
      } else if (key === "expected outcome" || key === "expected") {
        currentSection = "expected";
        if (rest) brief.expectedOutcome = rest;
      } else if (key === "notes") {
        currentSection = "notes";
        if (rest) notesLines.push(rest);
      } else if (key === "tasks") {
        currentSection = "tasks";
        if (rest) brief.tasks.push({ summary: rest });
      }
      continue;
    }

    if (!line.trim()) continue;

    if (currentSection === "tasks" && /^[\-\*]\s+/.test(line)) {
      brief.tasks.push({ summary: line.replace(/^[\-\*]\s+/, "").trim() });
    } else if (currentSection === "team" && !brief.teamName) {
      brief.teamName = line.trim();
    } else if (currentSection === "goal" && !brief.goal) {
      brief.goal = line.trim();
    } else if (currentSection === "mission" && !brief.mission) {
      brief.mission = line.trim();
    } else if (currentSection === "expected" && !brief.expectedOutcome) {
      brief.expectedOutcome = line.trim();
    } else if (currentSection === "notes" || !currentSection) {
      notesLines.push(line.trim());
    }
  }

  if (notesLines.length > 0) {
    brief.notes = notesLines.join("\n");
  }

  if (!brief.teamName && !brief.goal && !brief.mission && brief.tasks.length === 0) {
    brief.tasks.push({ summary: raw });
  }

  return brief;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
// ── Natural language routing (voice notes / plain messages) ──────────────────

async function handleNaturalLanguageTask(chatId: number, text: string, env: Env): Promise<void> {
  const brief = parseBrief(text);

  const previewLines: string[] = [];
  if (brief.teamName) previewLines.push(`<b>Team:</b> ${escapeHtml(brief.teamName)}`);
  if (brief.goal) previewLines.push(`<b>Goal:</b> ${escapeHtml(brief.goal)}`);
  if (brief.mission) previewLines.push(`<b>Mission:</b> ${escapeHtml(brief.mission)}`);
  if (brief.expectedOutcome) previewLines.push(`<b>Expected:</b> ${escapeHtml(brief.expectedOutcome)}`);
  if (brief.tasks.length > 0) {
    previewLines.push(
      `<b>Tasks:</b>\n` +
      brief.tasks.map((t, i) => `${i + 1}. ${escapeHtml(t.summary)}`).join("\n")
    );
  } else {
    previewLines.push(`<b>Tasks:</b>\n1. ${escapeHtml(text.trim())}`);
  }

  await sendMessage(
    env,
    chatId,
    `📝 <b>Brief received</b>\n\n${previewLines.join("\n\n")}\n\n` +
    `Reply with <code>/task research ...</code> if you want to queue one manually for now.`
  );
}

// ── Intel review: auto-triggered when URLs are detected ──────────────────────

async function handleIntelReview(
  chatId: number,
  urls: string[],
  fullText: string,
  env: Env,
): Promise<void> {
  for (const url of urls.slice(0, 3)) { // max 3 URLs per message
    const taskId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Parse GitHub owner/repo from URL if present
    const githubMatch = url.match(/github\.com\/([^/]+)\/([^/?\s]+)/);
    const repoContext = githubMatch
      ? `owner: ${githubMatch[1]}, repo: ${githubMatch[2]}`
      : `url: ${url}`;

    await run(env.DB,
      `INSERT INTO tasks (id, kind, status, assigned_agent_id, team_id, input, spawn_depth, created_at, updated_at)
       VALUES (?, 'intel_review', 'pending', 'agent-intel-lead', 'team-intel', ?, 0, ?, ?)`,
      [
        taskId,
        JSON.stringify({
          summary: url,
          details: `Submitted via Telegram. Context: "${fullText.slice(0, 200)}". Repo: ${repoContext}`,
          source: "telegram_intel",
          url,
          ...(githubMatch ? { owner: githubMatch[1], repo: githubMatch[2] } : {}),
        }),
        now, now,
      ],
    );

    const intelEta = TASK_ETA_SECONDS["intel_review"] ?? 120;
    const intelText =
      `🔍 <b>Intel Review</b> started\n` +
      `${progressBar(0, 10)} ETA ~${intelEta}s\n` +
      `URL: <code>${url}</code>\n` +
      `ID: <code>${taskId}</code>`;
    const tgRes = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: intelText, parse_mode: "Markdown" }) },
    );
    const tgData = await tgRes.json<{ ok: boolean; result?: { message_id: number } }>();
    if (tgData.ok && tgData.result?.message_id) {
      await run(env.DB,
        "UPDATE tasks SET telegram_chat_id=?, telegram_message_id=? WHERE id=?",
        [chatId, tgData.result.message_id, taskId],
      );
    }
  }
}

// ── Proposal System: /propose, /proposals, /crons ─────────────────────────

async function handleProposeCommand(chatId: number, args: string[], env: Env): Promise<void> {
  if (args.length === 0) {
    await sendMessage(env, chatId,
      `📋 <b>Proposal Types</b>\n\n` +
      `<code>/propose cron_request</code>\n` +
      `Schedule a recurring cron job\n\n` +
      `<code>/propose dept_task</code>\n` +
      `Add a new department or agent task\n\n` +
      `Usage:\n` +
      `<code>/propose cron_request<br/>` +
      `Task: cost_report<br/>` +
      `When: 0 9 * * *</code>`
    );
    return;
  }

  const proposalType = args[0]?.toLowerCase();
  const proposalContent = args.slice(1).join(" ");

  if (!["cron_request", "dept_task", "tool_add", "agent_add"].includes(proposalType)) {
    await sendMessage(env, chatId, `Invalid proposal type: <code>${proposalType}</code>`);
    return;
  }

  // Create proposal in DB
  const proposalId = crypto.randomUUID();
  const now = new Date().toISOString();

  await run(env.DB,
    `INSERT INTO proposals (id, type, team_id, agent_id, title, description, status, created_at, approved_by)
     VALUES (?, ?, 'team-research', 'agent-research-lead', ?, ?, 'pending', ?, ?)`,
    [proposalId, proposalType, `${proposalType} proposal`, proposalContent, now, null],
  );

  await sendMessage(env, chatId,
    `✅ <b>Proposal Created</b>\n\n` +
    `ID: <code>${proposalId}</code>\n` +
    `Type: <code>${proposalType}</code>\n` +
    `Status: Pending your approval\n\n` +
    `<code>/approve ${proposalId}</code> — Approve\n` +
    `<code>/reject ${proposalId}</code> — Reject`
  );
}

async function handleProposalsCommand(chatId: number, env: Env): Promise<void> {
  const pending = await query<{ id: string; type: string; title: string; created_at: string }>(
    env.DB,
    "SELECT id, type, title, created_at FROM proposals WHERE status='pending' ORDER BY created_at DESC LIMIT 10",
    [],
  );

  if (pending.length === 0) {
    await sendMessage(env, chatId, "No pending proposals.");
    return;
  }

  const lines = pending.map((p) =>
    `• <b>${p.type}</b>: ${p.title}\n  <code>/approve ${p.id}</code>`
  );

  await sendMessage(env, chatId,
    `📋 <b>Pending Proposals (${pending.length})</b>\n\n${lines.join("\n\n")}`
  );
}

async function handleCronsCommand(chatId: number, env: Env): Promise<void> {
  const crons = await query<{ id: string; cron_expression: string; task_kind: string; status: string }>(
    env.DB,
    "SELECT id, cron_expression, task_kind, status FROM scheduled_crons WHERE status='active' LIMIT 15",
    [],
  );

  if (crons.length === 0) {
    await sendMessage(env, chatId,
      `No active crons yet.\n\n` +
      `<code>/propose cron_request</code> to create one.`
    );
    return;
  }

  const lines = crons.map((c) =>
    `<code>${c.cron_expression}</code> — ${c.task_kind}`
  );

  await sendMessage(env, chatId,
    `🕐 <b>Active Crons (${crons.length})</b>\n\n${lines.join("\n")}`
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface TelegramUpdate {
  message?: {
    message_id: number;
    text?: string;
    voice?: { file_id: string; duration: number };
    audio?: { file_id: string; duration: number };
    chat: { id: number };
    from?: { id: number; username?: string };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    data?: string;
  };
}