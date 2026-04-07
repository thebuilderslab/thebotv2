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

    // ── Auto intel review: GitHub/social URLs sent as plain message ──────────
    if (!text.startsWith("/") && text.length > 0) {
      const urlMatches = text.match(INTEL_URL_PATTERN);
      if (urlMatches && urlMatches.length > 0) {
        await handleIntelReview(chatId, urlMatches, text, env);
        return new Response("OK");
      }
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
        `🤖 *Bot Nation — Nation Supervisor*\n\n` +
        `Available commands:\n` +
        `\`/task <kind> <summary>\` — spawn a task\n` +
        `\`/status <taskId>\` — check task status\n` +
        `\`/approve <proposalId>\` — approve a proposal\n` +
        `\`/agents\` — list active agents\n` +
        `\`/stats\` — system overview\n\n` +
        `Task kinds: \`research\` · \`deep_research\` · \`content_generation\` · \`code_change\` · \`improvement_proposal\` · \`config_change\` · \`wallet_simulation\``
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

    case "/stats":
      await handleStatsCommand(chatId, env);
      break;

    default:
      await sendMessage(env, chatId, `Unknown command: \`${cmd}\`\nType /help for available commands.`);
  }
}

// ── /task <kind> <summary…> ───────────────────────────────────────────────────

async function handleTaskCommand(chatId: number, args: string[], env: Env): Promise<void> {
  if (args.length < 2) {
    await sendMessage(env, chatId,
      `Usage: \`/task <kind> <summary>\`\n\nExample:\n\`/task research What is LangGraph?\``
    );
    return;
  }

  const kind = (args[0] ?? "").toLowerCase();
  const rawSummary = args.slice(1).join(" ");

  // Sanitise user input before storing or routing
  const { safe: summary, flagged, reasons } = sanitiseInput(rawSummary);
  if (flagged) {
    await sendMessage(env, chatId,
      `⚠️ Input contained restricted patterns and was sanitised:\n\`${reasons.join("; ")}\``
    );
  }

  const routing = TASK_KIND_ROUTING[kind];
  if (!routing) {
    const kinds = Object.keys(TASK_KIND_ROUTING).join(" · ");
    await sendMessage(env, chatId, `Unknown task kind: \`${kind}\`\n\nValid kinds: ${kinds}`);
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

  await sendMessage(env, chatId,
    `✅ *Task created*\n\n` +
    `ID: \`${taskId}\`\n` +
    `Kind: \`${kind}\`\n` +
    `Assigned to: \`${routing.agentId}\`\n` +
    `Team: \`${routing.teamId}\`\n\n` +
    `Check status with:\n\`/status ${taskId}\``
  );
}

// ── /status <taskId> ──────────────────────────────────────────────────────────

async function handleStatusCommand(chatId: number, taskId: string | undefined, env: Env): Promise<void> {
  if (!taskId) {
    await sendMessage(env, chatId, `Usage: \`/status <taskId>\``);
    return;
  }

  const task = await queryOne<{
    id: string; kind: string; status: string; output: string | null;
    assigned_agent_id: string | null; created_at: string; updated_at: string;
  }>(env.DB, "SELECT id, kind, status, output, assigned_agent_id, created_at, updated_at FROM tasks WHERE id = ?", [taskId]);

  if (!task) {
    await sendMessage(env, chatId, `Task \`${taskId}\` not found.`);
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
      outputText = `\n\n📝 *Summary:*\n${out.summary ?? "(no summary)"}`;
    } catch { /* ignore */ }
  }

  await sendMessage(env, chatId,
    `${statusEmoji[task.status] ?? "❓"} *Task Status*\n\n` +
    `ID: \`${task.id}\`\n` +
    `Kind: \`${task.kind}\`\n` +
    `Status: \`${task.status}\`\n` +
    `Agent: \`${task.assigned_agent_id ?? "unassigned"}\`\n` +
    `Updated: \`${task.updated_at}\`` +
    outputText
  );
}

// ── /approve <proposalId> ─────────────────────────────────────────────────────

async function handleApproveCommand(chatId: number, proposalId: string | undefined, env: Env): Promise<void> {
  if (!proposalId) {
    await sendMessage(env, chatId, `Usage: \`/approve <proposalId>\``);
    return;
  }

  const proposal = await queryOne<{ id: string; title: string; status: string }>(
    env.DB, "SELECT id, title, status FROM proposals WHERE id = ?", [proposalId],
  );

  if (!proposal) {
    await sendMessage(env, chatId, `Proposal \`${proposalId}\` not found.`);
    return;
  }

  if (proposal.status !== "pending") {
    await sendMessage(env, chatId, `Proposal is already \`${proposal.status}\`.`);
    return;
  }

  const now = new Date().toISOString();
  await run(env.DB, "UPDATE proposals SET status='approved', updated_at=? WHERE id=?", [now, proposalId]);

  // Find linked approval and approve it too
  const approval = await queryOne<{ id: string }>(
    env.DB, "SELECT id FROM approvals WHERE proposal_id = ? AND status = 'pending'", [proposalId],
  );
  if (approval) {
    await run(env.DB, "UPDATE approvals SET status='approved', updated_at=? WHERE id=?", [now, approval.id]);
    await applyChangeForApproval(env.DB, approval.id, "telegram-operator", null);
  }

  await sendMessage(env, chatId,
    `✅ *Proposal approved*\n\n` +
    `ID: \`${proposalId}\`\n` +
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
    `${domainEmoji[a.domain] ?? "•"} *${a.name}* (\`${a.role}\`) — \`${a.id}\``
  );

  await sendMessage(env, chatId,
    `🤖 *Active Agents (${agents.length})*\n\n${lines.join("\n")}`
  );
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
    `📊 *Bot Nation Stats*\n\n` +
    `*Tasks*\n` +
    `  Total: ${tasks?.total ?? 0} · Pending: ${tasks?.pending ?? 0} · Running: ${tasks?.running ?? 0}\n` +
    `  Completed: ${tasks?.completed ?? 0} · Failed: ${tasks?.failed ?? 0}\n\n` +
    `*System*\n` +
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
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    }),
  });
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

    await sendMessage(env, chatId, `📝 *Transcribed:* "${transcribedText}"`);

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

// ── Natural language routing (voice notes / plain messages) ──────────────────

async function handleNaturalLanguageTask(chatId: number, text: string, env: Env): Promise<void> {
  // Route to Nation Supervisor as a research task — it will classify and delegate
  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();

  await run(env.DB,
    `INSERT INTO tasks (id, kind, status, assigned_agent_id, team_id, input, spawn_depth, created_at, updated_at)
     VALUES (?, 'research', 'pending', 'agent-nation-supervisor', 'team-research', ?, 0, ?, ?)`,
    [taskId, JSON.stringify({ summary: text, source: "telegram_voice" }), now, now],
  );

  await sendMessage(env, chatId,
    `✅ *Routing to Nation Supervisor*\n\n` +
    `"${text.slice(0, 100)}${text.length > 100 ? "..." : ""}"\n\n` +
    `Task ID: \`${taskId}\`\nCheck with: \`/status ${taskId}\``
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

    await sendMessage(env, chatId,
      `🔍 *Intel Review started*\n\n` +
      `URL: \`${url}\`\n` +
      `Task: \`${taskId}\`\n` +
      `Agent: Intel Lead → Repo Researcher + Value Assessor\n\n` +
      `_Will produce: Safety · Value · Recommendation_\n` +
      `Check with: \`/status ${taskId}\``
    );
  }
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
