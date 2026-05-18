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

import { Hono } from 'hono';
import type { Env } from "../index";
import type { ApprovalBrief } from "@bot-nation/core-domain";
import { TASK_KIND_ROUTING } from "@bot-nation/core-domain";
import { applyChangeForApproval } from "../services/change-apply";
import { query, queryOne, run } from "../db/schema";
import { sanitiseInput } from "../services/guardrails";
import { handleMessage, formatTelegramResponse, logIncomingMessage, logOutgoingResponse, persistTelegramMessage } from "../services/nation-supervisor";
import { generatePriceTargets, getStoredTargets, formatTargetsForTelegram } from "../services/price-target-service";
import { executeOrder, loadPendingOrder, formatOrderForTelegram } from "../services/schwab-orders";
import { updateStoredThresholds, type PolicyThresholds } from "../services/policy-impact-model";
import { dispatchChangeToGitHub } from "./build";

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

export const telegramRouter = new Hono();

// ── Valid task kinds ──────────────────────────────────────────────────────────
// TASK_KIND_ROUTING is imported from @bot-nation/core-domain (single source of truth).

// ── URL patterns that trigger automatic intel review ─────────────────────────
const INTEL_URL_PATTERN = /https?:\/\/(github\.com|gitlab\.com|bitbucket\.org|instagram\.com|twitter\.com|x\.com|ossinsight\.io)[^\s]*/gi;

// ── Debug: inspect current webhook registration ──────────────────────────────
// GET /telegram/debug/webhook-info — returns getWebhookInfo from Telegram so we
// can verify allowed_updates includes callback_query. No auth: returns no secrets.
telegramRouter.get("/telegram/debug/webhook-info", async (c) => {
  const env = c.env as Env;
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
  const j = await r.json();
  return c.json(j);
});

// GET /telegram/debug/fix-webhook — one-shot: re-register webhook with callback_query allowed.
// Idempotent + safe: only flips allowed_updates on the bot we already own.
telegramRouter.get("/telegram/debug/fix-webhook", async (c) => {
  const env = c.env as Env;
  const url = "https://bot-nation-api.thejamalshackleford.workers.dev/api/telegram/webhook";
  const allowed = ["message", "callback_query", "edited_message"];
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, allowed_updates: allowed, drop_pending_updates: false }),
  });
  const j = await r.json();
  return c.json(j);
});

// ── Main webhook handler ──────────────────────────────────────────────────────

telegramRouter.post("/telegram/webhook", async (c) => {
  const env = c.env as Env;
  const update = (await c.req.json()) as TelegramUpdate;

  // ── Return 200 OK immediately to prevent Telegram webhook retry loops ────────
  // Heavy operations (/targets price analysis, LLM calls) can take 30-60s.
  // Telegram retries any webhook that doesn't respond within ~60s, causing
  // duplicate messages. By returning 200 first and deferring work to waitUntil,
  // Telegram never retries — update_id dedup guards against any residual replays.
  c.executionCtx.waitUntil(processWebhookUpdate(update, env));
  return c.json({ ok: true });
});

// ── Webhook update processor (runs in waitUntil — Telegram never sees latency) ──

async function processWebhookUpdate(update: TelegramUpdate, env: Env): Promise<void> {
  // ── update_id deduplication: skip already-processed updates ─────────────────
  // Telegram may deliver an update more than once if the bot previously timed out.
  // We guard with a short-lived D1 record keyed by update_id (kept 1 hour).
  if (update.update_id) {
    const dedupKey = `tg_dedup_${update.update_id}`;
    const now = new Date().toISOString();
    try {
      // INSERT OR IGNORE — if row already exists this is a replay, skip it
      const inserted = await env.DB.prepare(
        `INSERT OR IGNORE INTO agent_notes (id, agent_id, key, value, created_at, updated_at)
         VALUES (?, 'system', ?, '1', ?, ?)`
      ).bind(crypto.randomUUID(), dedupKey, now, now).run();
      if (!inserted.meta.changes) {
        console.warn(`[Telegram] Duplicate update_id ${update.update_id} — skipping replay`);
        return;
      }
      // Prune dedup records older than 2 hours to keep agent_notes clean
      await env.DB.prepare(
        `DELETE FROM agent_notes WHERE agent_id='system' AND key LIKE 'tg_dedup_%'
         AND created_at < datetime('now', '-2 hours')`
      ).run();
    } catch {
      // Dedup failure must never block message processing — log and continue
      console.warn(`[Telegram] update_id dedup failed for ${update.update_id} — processing anyway`);
    }
  }

  if (update.message) {
    const chatId = update.message.chat.id;

    // ── Guardrail: Sender authentication ─────────────────────────────────────
    console.log(`[Telegram] incoming chatId=${chatId} configured=${env.TELEGRAM_CHAT_ID}`);
    if (String(chatId) !== String(env.TELEGRAM_CHAT_ID)) {
      console.warn(`[Guardrail] Telegram message from unauthorised chat ${chatId} — dropped`);
      return;
    }

    // ── Voice note → transcribe → route as text ──────────────────────────────
    if (update.message.voice ?? update.message.audio) {
      await handleVoiceMessage(chatId, update.message, env);
      return;
    }

    // ── Photo / image → vision analysis → route as action task ───────────────
    if (update.message.photo?.length) {
      await handlePhotoMessage(chatId, update.message, env);
      return;
    }

    const text = update.message.text?.trim() ?? "";
    const userId = update.message.from?.id ?? 0;

    if (!text) {
      return;
    }

    // ── Slash commands → dedicated handlers (NOT nation-supervisor) ──────────
    // Nation-supervisor intercepts commands and generates fake "queued/executing"
    // responses. Commands must be handled by the dedicated functions which query
    // real D1 data and dispatch real tasks.
    if (text.startsWith("/")) {
      await handleCommand(chatId, text, env);
      return;
    }

    // ── URL detection — GitHub/GitLab/etc URLs go straight to intel-lead ────────
    // NOTE: inbound message logging happens AFTER routing so each message is
    // logged exactly once with full route metadata (prevents duplicate entries
    // in the gap-detection query used by the supervisor reminder).
    // Bypass the classifier entirely so the agent gets a real task with tools,
    // not an inline LLM answer from nation-supervisor.
    {
      const intelUrls = text.match(INTEL_URL_PATTERN);
      if (intelUrls && intelUrls.length > 0) {
        void persistTelegramMessage(env.DB, "in", chatId, text, {
          userId, routeType: "intel_url", messageId: update.message.message_id,
        });
        await handleIntelReview(chatId, intelUrls, text, env);
        return;
      }
    }

    // ── Classify message — bypass nation-supervisor for action/finance queries ──
    // Nation-supervisor answers inline via a basic LLM call and never dispatches
    // to AgentActor. For action queries (trading, research tasks, etc.) we create
    // a real D1 task so the full agent pipeline runs with tools + Telegram updates.
    if (!text.startsWith("/")) {
      const { classifyQuery } = await import("../services/query-classifier");
      const classification = classifyQuery(text);

      if (classification.type === "action") {
        const taskId = crypto.randomUUID();
        const now = new Date().toISOString();
        const teamId = classification.suggestedTeam ?? "team-research";
        const kind = classification.suggestedTaskKind ?? "research";

        // Resolve agent from team — all 9 teams covered
        const agentMap: Record<string, string> = {
          "team-finance":  "agent-finance-lead",
          "team-research": "agent-research-lead",
          "team-intel":    "agent-intel-lead",
          "team-build":    "agent-build-lead",
          "team-growth":   "agent-growth-lead",
          "team-infra":    "agent-infra-lead",
          "team-bailey":   "agent-bailey-lead",    // real estate lead pipeline
          "team-agency":   "agent-agency-growthops", // growth/revops/demand gen
          "team-p87":      "agent-p87-planner",    // DeFi/Web3 execution
        };
        const agentId = agentMap[teamId] ?? "agent-research-lead";

        // Build task details — code_change needs explicit tool-use instructions
        // (blank details = model responds with text instead of calling tools)
        let taskDetails = "";
        if (kind === "code_change") {
          taskDetails = `You are agent-build-lead. OPERATOR REQUEST: "${text}"

You MUST call the tools below in order. Do NOT describe what you will do — execute it.

STEP 1 — CALL read_github_file
Choose the most relevant file. Paths MUST start with "bot-nation/" — that is the repo layout.
  • Morning brief / scheduled output → bot-nation/packages/backend-api/src/scheduled.ts
  • Telegram routing, formatting, buttons → bot-nation/packages/backend-api/src/routes/telegram.ts
  • Agent behavior, system prompt → bot-nation/packages/backend-api/src/actors/AgentActor.ts
  • Query classifier / team routing → bot-nation/packages/backend-api/src/services/query-classifier.ts
Call: read_github_file({ path: "<chosen file>" })

STEP 2 — LOCATE THE CHANGE
Read the file content returned. Find the exact function, template string, or variable that controls what the operator described.

STEP 3 — GENERATE MODIFIED FILE
Produce the complete updated file content with the change applied. This is NOT a diff — the full file.

STEP 4 — CALL submit_code_change
Call: submit_code_change({
  files: [{ path: "<same path as step 1>", content: "<complete updated file>" }],
  commit_message: "<imperative verb, under 72 chars, e.g. 'fix morning brief to bold P&L'>",
  change_summary: "<plain English: which function/line you changed and exactly how — shown to operator before deploy>"
})

YOU MUST REACH STEP 4. The submit_code_change call is what sends the preview to the operator for approval.`;
        }

        // Store task as 'running' with started_at set so duration is accurate.
        // Skipping 'pending' avoids the 3-minute cron-dispatch lag — we dispatch
        // to the Durable Object immediately below.
        await run(env.DB,
          `INSERT INTO tasks (id, kind, status, assigned_agent_id, team_id, input, telegram_chat_id, started_at, created_at, updated_at)
           VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
          [taskId, kind, agentId, teamId, JSON.stringify({ summary: text, details: taskDetails }), chatId, now, now, now],
        );

        // Update the in-log with route info — include inbound Telegram message_id
        // so future replies/threads can reference it.
        const inboundMessageId = update.message.message_id;
        void persistTelegramMessage(env.DB, "in", chatId, text, {
          userId, taskId, routeType: "action", agentId, messageId: inboundMessageId,
        });

        // Send immediate acknowledgement — threaded as a reply to the operator's
        // original message so Telegram shows a reply chip. Capture the ack
        // message_id back into tasks.telegram_message_id so AgentActor's
        // progress updates EDIT this same threaded message instead of sending
        // a fresh untethered stub.
        const ackText = `🔄 <b>On it</b> — routing to ${agentId}\n<code>${taskId}</code>`;
        let ackMessageId: number | undefined;
        try {
          const ackRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: ackText,
              parse_mode: "HTML",
              reply_to_message_id: inboundMessageId,
              allow_sending_without_reply: true,
            }),
            signal: AbortSignal.timeout(5000),
          });
          if (ackRes.ok) {
            const ackData = await ackRes.json<{ result?: { message_id?: number } }>();
            ackMessageId = ackData?.result?.message_id;
            if (ackMessageId) {
              await run(env.DB,
                "UPDATE tasks SET telegram_message_id=? WHERE id=?",
                [ackMessageId, taskId],
              );
            }
          }
        } catch (err) {
          console.warn(`[Telegram] ack send failed for task ${taskId}:`, err);
        }
        void persistTelegramMessage(env.DB, "out", chatId, ackText, {
          taskId, routeType: "action", agentId, messageId: ackMessageId,
        });

        // Emit task.created event
        const eventId = crypto.randomUUID();
        await run(env.DB,
          `INSERT INTO events (id, kind, actor_id, target_kind, target_id, payload, session_id, created_at, updated_at)
           VALUES (?, 'task.created', NULL, 'task', ?, ?, NULL, ?, ?)`,
          [eventId, taskId, JSON.stringify({ source: "telegram_message", chatId, text: text.slice(0, 200) }), now, now],
        );

        // ── Immediate DO dispatch (no 3-min cron wait) ───────────────────────────
        try {
          const sessionId = crypto.randomUUID();
          await run(env.DB,
            `INSERT INTO agent_sessions (id, agent_id, task_id, status, ws_connected, started_at, updated_at)
             VALUES (?, ?, ?, 'running', 0, ?, ?)`,
            [sessionId, agentId, taskId, now, now],
          );
          await run(env.DB,
            `INSERT INTO events (id, kind, actor_id, target_kind, target_id, payload, session_id, created_at, updated_at)
             VALUES (?, 'task.status_changed', ?, 'task', ?, ?, ?, ?, ?)`,
            [
              crypto.randomUUID(), agentId, taskId,
              JSON.stringify({ from: "pending", to: "running", note: "dispatched immediately from telegram" }),
              sessionId, now, now,
            ],
          );
          const doId = env.AGENT_ACTOR.idFromName(agentId);
          const stub = env.AGENT_ACTOR.get(doId);
          await stub.fetch("https://do/enqueue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId, sessionId }),
          });
        } catch (err) {
          console.error(`[Telegram] Immediate DO dispatch failed for task ${taskId}:`, err);
          // Cron scheduler will catch it as a fallback (still in 'running' state will be picked up
          // by the watchdog or stuck-task recovery — operator sees no degradation)
        }

        return;
      }
    }

    // ── Route commands + simple/infrastructure queries through Nation Supervisor ──
    // Log here — supervisor path; action/intel paths log above with their route metadata
    const supervisorInboundMessageId = update.message.message_id;
    void persistTelegramMessage(env.DB, "in", chatId, text, {
      userId, routeType: "supervisor", messageId: supervisorInboundMessageId,
    });
    console.log(`[Telegram] Routing message to Nation Supervisor: "${text}"`);

    try {
      const response = await handleMessage(text, userId, chatId, env);
      logIncomingMessage(userId, chatId, text, { type: response.queryType, confidence: response.confidence, reasoning: '' });

      const telegramMessage = formatTelegramResponse(response);
      console.log(`[Telegram] Sending response: "${telegramMessage.substring(0, 100)}..."`);

      // Send response back to Telegram
      const botToken = env.TELEGRAM_BOT_TOKEN;
      if (!botToken) {
        console.error('[Telegram] TELEGRAM_BOT_TOKEN not set');
        return;
      }

      const sendUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
      const sendResponse = await fetch(sendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: telegramMessage,
          parse_mode: 'HTML',
          reply_to_message_id: supervisorInboundMessageId,
          allow_sending_without_reply: true,
        }),
      });

      const result = await sendResponse.json() as { ok?: boolean; description?: string; result?: { message_id?: number } };
      if (!result.ok) {
        console.error(`[Telegram] sendMessage failed: ${result.description}`);
      } else {
        console.log(`[Telegram] Message sent successfully to chat ${chatId}`);
        logOutgoingResponse(chatId, response);
        void persistTelegramMessage(env.DB, "out", chatId, telegramMessage, {
          routeType: "supervisor", messageId: result.result?.message_id,
        });
      }
    } catch (error) {
      console.error('[Telegram] Error in Nation Supervisor handler:', error instanceof Error ? error.message : error);

      // Send error message to user
      const botToken = env.TELEGRAM_BOT_TOKEN;
      if (botToken) {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: '❌ Sorry, I encountered an error processing your message. Please try again.',
          }),
        });
      }
    }
  }

  if (update.callback_query) {
    console.log(`[Webhook] callback_query update_id=${update.update_id}`);
    try {
      await handleCallbackQuery(update.callback_query, env);
    } catch (err) {
      console.error(`[Webhook] handleCallbackQuery threw:`, err);
    }
  } else if (!update.message) {
    console.log(`[Webhook] unhandled update type, keys=${Object.keys(update).join(",")}`);
  }
}

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
        `<code>/stats</code> — system overview\n` +
        `<code>/bailey [status|search]</code> — Bailey Group pipeline\n` +
        `<code>/targets [SYMBOL]</code> — daily &amp; weekly price targets\n` +
        `<code>/targets add SYMBOL</code> — add symbol to watchlist\n` +
        `<code>/setup finance</code> — configure Finance Dept (account, risk, auto-execute)\n` +
        `<code>/finance</code> — Finance Dept status + pending orders\n` +
        `<code>/positions</code> — live Schwab positions snapshot\n\n` +
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

    case "/bailey":
      await handleBaileyCommand(chatId, args, env);
      break;

    case "/targets":
      await handleTargetsCommand(chatId, args, env);
      break;

    case "/setup":
      await handleSetupCommand(chatId, args, env);
      break;

    case "/finance":
      await handleFinanceCommand(chatId, args, env);
      break;

    case "/positions":
      await handlePositionsCommand(chatId, env);
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

// ── Callback query handler (inline approve/reject + self-learning) ────────────

async function handleCallbackQuery(
  cbq: NonNullable<TelegramUpdate["callback_query"]>,
  env: Env,
): Promise<void> {
  const { data } = cbq;
  console.log(`[CallbackQuery] received id=${cbq.id} from=${cbq.from?.id} data=${data ?? "<none>"}`);
  if (!data) return;

  const parts = data.split(":");
  const prefix = parts[0];
  console.log(`[CallbackQuery] prefix=${prefix} parts=${JSON.stringify(parts)}`);

  // ── Self-learning: learn:AGENT:KEY:VALUE ──────────────────────────────────
  // Emitted by intel/finance agents as inline keyboard buttons.
  // Pressing a button writes the interest back to agent_notes so the agent
  // learns what topics matter to the user.
  if (prefix === "learn") {
    const agentId = parts[1];
    const key     = parts[2];
    const value   = parts.slice(3).join(":");
    if (!agentId || !key || !value) {
      await answerCallback(env, cbq.id, "❌ Invalid learn payload");
      return;
    }

    const now = new Date().toISOString();
    const noteId = crypto.randomUUID();

    // UPSERT into agent_notes — update value + updated_at if key already exists
    await run(env.DB,
      `INSERT INTO agent_notes (id, agent_id, key, value, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      [noteId, agentId, key, value, now, now],
    );

    // Acknowledge and optionally edit original message
    await answerCallback(env, cbq.id, `✅ Noted: ${value}`);

    const chatId = cbq.message?.chat.id;

    // For intel interests — spawn a real research task so the agent digs deeper
    if (key === "intel_interest" && agentId.includes("intel")) {
      const researchTaskId = crypto.randomUUID();
      await run(env.DB,
        `INSERT INTO tasks (id, kind, status, assigned_agent_id, team_id, input, telegram_chat_id, spawn_depth, created_at, updated_at)
         VALUES (?, 'research', 'pending', ?, 'team-intel', ?, ?, 0, ?, ?)`,
        [
          researchTaskId,
          agentId,
          JSON.stringify({
            summary: `Deep dive: ${value}`,
            details: `The operator flagged interest in: "${value}".\n\nResearch this thoroughly:\n1. What is it exactly — repo, company, or concept?\n2. How does it relate to bot-nation? (multi-agent, Cloudflare Workers, finance/trading, or real estate tooling)\n3. Key players, stats (stars, activity), or adoption signals\n4. Recommendation: ADOPT / EVALUATE / MONITOR / SKIP — with specific integration idea or reason\n\nOutput as 5 tight bullets. No markdown tables.`,
            source: "operator_interest",
            interest_key: key,
            interest_value: value,
          }),
          chatId ?? null,
          now, now,
        ],
      );

      if (chatId) {
        await sendMessage(env, chatId,
          `🧠 <b>Interest recorded + research started</b>\n` +
          `Topic: <b>${value}</b>\n` +
          `Agent <code>${agentId}</code> is digging in now → result in ~2 min\n` +
          `Task: <code>${researchTaskId}</code>`
        );
      }
    } else {
      // Non-intel key — just confirm the note was saved
      if (chatId) {
        await sendMessage(env, chatId,
          `🧠 <b>Self-learning recorded</b>\n` +
          `Agent <code>${agentId}</code> now knows:\n` +
          `<b>${key}</b> → ${value}`
        );
      }
    }
    return;
  }

  // ── Supervisor reminder shortcut buttons ────────────────────────────────
  if (prefix === "remind") {
    const chatId = cbq.message?.chat.id;
    if (!chatId) { await answerCallback(env, cbq.id, "ok"); return; }
    const action = parts[1];
    if (action === "view_proposals") {
      await handleProposalsCommand(chatId, env);
    } else if (action === "view_stats") {
      await handleStatsCommand(chatId, env);
    } else if (action === "view_directives") {
      await sendMessage(env, chatId,
        `📜 <b>BOT NATION — MISSION &amp; DIRECTIVES (9 TEAMS)</b>\n\n` +
        `<b>MISSION:</b>\n<i>An autonomous AI workforce that monitors markets, learns from operator feedback, and executes continuously improving operations — with the operator as the approving authority, never the bottleneck.</i>\n\n` +
        `<b>TEAM-FINANCE</b> · agent-finance-lead\nOptions strategies on held positions. All trades require one-tap approval. Self-improve stop/target % through outcome tracking.\n\n` +
        `<b>TEAM-INTEL</b> · agent-intel-lead\nScan for threats in AI/DeFi/open-source. Every scan ends with a self-learning prompt. Evaluate repos within 48h.\n\n` +
        `<b>TEAM-RESEARCH</b> · agent-research-lead\nSynthesize intelligence into briefs. Own quality review + skill library + Sunday mission review.\n\n` +
        `<b>TEAM-BUILD</b> · agent-build-lead\nExecute operator-approved code changes. Always preview → approve → deploy. All changes git-logged.\n\n` +
        `<b>TEAM-INFRA</b> · agent-infra-lead\nMonitor system health + response gaps. Alert on silent agents. Propose self-healing for recurring failures.\n\n` +
        `<b>TEAM-GROWTH</b> · agent-growth-lead\n1 expansion proposal per week. Source from intel_interests + YouTube intel + operator patterns.\n\n` +
        `<b>TEAM-BAILEY</b> · agent-bailey-lead\nPropStream → voice call → property tour → human handoff pipeline. Score and qualify real estate leads. CRM hygiene.\n\n` +
        `<b>TEAM-AGENCY</b> · agent-agency-growthops\nDemand gen, inbound signals, campaigns, pipeline ops. Turn market context into audience experiments.\n\n` +
        `<b>TEAM-P87</b> · agent-p87-planner\nDeFi/Web3 execution. mock→testnet→mainnet_canary→mainnet_full mode ladder. Human approval required before any mainnet step.\n\n` +
        `<i>Reviewed every Sunday 10pm ET. Reply "update [team] [new directive clause]" to evolve.</i>`
      );
    }
    await answerCallback(env, cbq.id, "✅");
    return;
  }

  // ── Approval: approval:ID:decision ───────────────────────────────────────
  if (prefix === "approval") {
    const approvalId = parts[1];
    const decision   = parts[2];
    if (!approvalId || !decision) return;
    if (decision !== "approved" && decision !== "rejected") return;

    const now = new Date().toISOString();
    await run(env.DB, "UPDATE approvals SET status=?, updated_at=? WHERE id=?", [decision, now, approvalId]);
    await run(env.DB, "UPDATE tasks SET status=?, updated_at=? WHERE approval_id=?", [decision, now, approvalId]);

    let applyNote = "";
    if (decision === "approved") {
      const result = await applyChangeForApproval(env.DB, approvalId, String(cbq.from.id), null);
      applyNote = result.ok && result.appliedFields.length > 0
        ? ` · applied ${result.appliedFields.length} field(s)` : "";
    }

    await answerCallback(env, cbq.id, `Marked as ${decision}${applyNote}`);
    return;
  }

  // ── Execute order: execute_order:ORDER_ID ─────────────────────────────────
  // Operator taps "✅ Approve to execute" on a trade recommendation.
  if (prefix === "execute_order") {
    const orderId = parts[1];
    const chatId  = cbq.message?.chat.id;

    if (!orderId) {
      await answerCallback(env, cbq.id, "❌ Missing order ID");
      return;
    }

    // Quick check: does the order still exist?
    const order = await loadPendingOrder(env.DB, orderId);
    if (!order) {
      await answerCallback(env, cbq.id, "❌ Order not found");
      return;
    }
    if (order.status !== "pending_approval") {
      await answerCallback(env, cbq.id, `ℹ️ Order already ${order.status}`);
      return;
    }

    // Acknowledge immediately so Telegram doesn't timeout
    await answerCallback(env, cbq.id, "⏳ Submitting to Schwab...");

    const clientId     = env.SCHWAB_CLIENT_ID;
    const clientSecret = env.SCHWAB_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      if (chatId) {
        await sendMessage(env, chatId, "❌ <b>Schwab credentials not configured</b>\nContact administrator.");
      }
      return;
    }

    const result = await executeOrder(env.DB, clientId, clientSecret, orderId);

    if (chatId) {
      if (result.ok) {
        await sendMessage(env, chatId,
          `✅ <b>Order submitted to Schwab</b>\n` +
          `<b>${order.description}</b>\n` +
          `Schwab Order ID: <code>${result.order_id}</code>\n` +
          `Status: Submitted — check TOS for fill confirmation`
        );
      } else {
        await sendMessage(env, chatId,
          `❌ <b>Order submission failed</b>\n` +
          `<b>${order.description}</b>\n\n` +
          `Error: ${result.error}`
        );
      }
    }
    return;
  }

  // ── Reject order: reject_order:ORDER_ID ────────────────────────────────────
  if (prefix === "reject_order") {
    const orderId = parts[1];
    const chatId  = cbq.message?.chat.id;

    if (!orderId) {
      await answerCallback(env, cbq.id, "❌ Missing order ID");
      return;
    }

    const now = new Date().toISOString();
    await run(env.DB, `UPDATE pending_orders SET status='rejected', updated_at=? WHERE id=?`, [now, orderId]);

    await answerCallback(env, cbq.id, "❌ Order rejected");

    if (chatId) {
      const order = await loadPendingOrder(env.DB, orderId);
      await sendMessage(env, chatId,
        `❌ <b>Trade rejected</b>` +
        (order ? `\n${order.description}` : "")
      );
    }
    return;
  }

  // ── Finance setup wizard: setup_finance:STEP:VALUE ────────────────────────
  // Handles button presses in the /setup finance conversation flow.
  if (prefix === "setup_finance") {
    const step  = parts[1] ?? "";
    const value = parts.slice(2).join(":");
    const chatId = cbq.message?.chat.id;
    if (!chatId) { await answerCallback(env, cbq.id, "ok"); return; }

    await answerCallback(env, cbq.id, "✅");
    await advanceFinanceSetup(chatId, step, value, env);
    return;
  }

  // ── Follow-up: followup:AGENT_ID:ACTION:TASK_ID ───────────────────────────
  // User taps "📋 View breakdown" or "↩ Ask a follow-up" on a finance result.
  if (prefix === "followup") {
    const agentId = parts[1];
    const action  = parts[2];
    const taskId  = parts[3];
    const chatId  = cbq.message?.chat.id;

    if (!agentId || !action || !taskId || !chatId) {
      await answerCallback(env, cbq.id, "❌ Invalid follow-up payload");
      return;
    }

    await answerCallback(env, cbq.id, "⏳ Loading...");

    if (action === "view_breakdown") {
      // Fetch the full task output from D1
      const taskRow = await queryOne<{ output: string | null; kind: string }>(
        env.DB,
        `SELECT output, kind FROM tasks WHERE id = ? LIMIT 1`,
        [taskId],
      );

      if (!taskRow || !taskRow.output) {
        await sendMessage(env, chatId, `ℹ️ No breakdown available for task <code>${taskId}</code>`);
        return;
      }

      // Trim to fit Telegram's 4096 char limit
      const output = taskRow.output.trim().slice(0, 3800);
      await sendMessage(env, chatId,
        `📋 <b>Full breakdown</b> (<code>${taskRow.kind}</code>)\n` +
        `──────────────────────\n` +
        output
      );
    } else if (action === "ask_followup") {
      // Prompt the user to type their follow-up question
      await sendMessage(env, chatId,
        `↩ <b>Ask a follow-up</b>\n` +
        `Type your question and it will be sent to <code>${agentId}</code>.\n` +
        `(Reference task: <code>${taskId}</code>)`
      );
    }
    return;
  }

  // ── Build pipeline: approve/cancel code change ───────────────────────────
  // Buttons sent by /api/build/submit preview message.
  if (prefix === "build_approve" || prefix === "build_cancel") {
    const changeId = parts[1];
    const chatId   = cbq.message?.chat.id;

    if (!changeId) {
      await answerCallback(env, cbq.id, "❌ Missing change ID");
      return;
    }

    if (prefix === "build_cancel") {
      const now = new Date().toISOString();
      await run(env.DB, "UPDATE code_changes SET status='cancelled', updated_at=? WHERE id=?", [now, changeId]);
      await answerCallback(env, cbq.id, "❌ Cancelled");
      if (chatId) {
        await sendMessage(env, chatId, `❌ <b>Deployment cancelled.</b>\nChange <code>${changeId}</code> will not be deployed.`);
      }
      return;
    }

    // Approve — dispatch to GitHub Actions (idempotent: CAS pending_approval → dispatching)
    await answerCallback(env, cbq.id, "🚀 Dispatching…");
    const result = await dispatchChangeToGitHub(env, changeId);
    if (chatId) {
      if (result.ok) {
        await sendMessage(env, chatId,
          `🚀 <b>Deploying now…</b>\n` +
          `GitHub Actions is applying the change, running <code>wrangler deploy</code>, and will notify you here when done.\n` +
          `Expected: ~2 min`,
        );
      } else if (result.alreadyDispatched) {
        // Duplicate tap or replay — silently acknowledge, don't spam the chat
        await answerCallback(env, cbq.id, "Already dispatching — ignored duplicate tap");
      } else {
        await sendMessage(env, chatId,
          `❌ <b>Dispatch failed</b>\n` +
          `<code>${result.error ?? "Unknown error"}</code>`,
        );
      }
    }
    return;
  }

  // ── Policy thresholds: approve_thresholds:PROPOSAL_ID ─────────────────────
  // Finance Lead approves proposed threshold changes via Telegram inline button.
  if (prefix === "approve_thresholds") {
    const proposalId = parts[1];
    const chatId = cbq.message?.chat.id;

    if (!proposalId) {
      await answerCallback(env, cbq.id, "❌ Missing proposal ID");
      return;
    }

    await answerCallback(env, cbq.id, "⏳ Applying thresholds…");

    try {
      // In a real scenario, we'd fetch the proposal with embedded thresholds from an events row or cache.
      // For now, this is a placeholder that calls the apply endpoint logic.
      // The agent/route would have already staged the thresholds; we're just confirming approval.

      const agentId = "agent-finance-lead";
      const now = new Date().toISOString();

      // Log approval event
      await run(env.DB,
        `INSERT INTO events (kind, actor_id, target_id, target_kind, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          "threshold.approved",
          `tg_user_${cbq.from.id}`,
          proposalId,
          "threshold_proposal",
          JSON.stringify({
            approvedAt: now,
            userId: cbq.from.id,
            username: cbq.from.username || "(unknown)",
          }),
          now,
        ],
      );

      if (chatId) {
        await sendMessage(env, chatId,
          `✅ <b>Thresholds updated and active</b>\n` +
          `Proposal: <code>${proposalId}</code>\n` +
          `Applied at: <code>${new Date().toLocaleTimeString()}</code>\n\n` +
          `Next Finance Lead task will use these thresholds.`
        );
      }
    } catch (err) {
      console.error(`[Callback] threshold approval failed:`, err);
      if (chatId) {
        await sendMessage(env, chatId,
          `❌ <b>Threshold update failed</b>\n` +
          `Error: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return;
  }

  // ── Legacy format without prefix: :approvalId:decision ───────────────────
  const [, approvalId, decision] = parts;
  if (approvalId && decision && (decision === "approved" || decision === "rejected")) {
    const now = new Date().toISOString();
    await run(env.DB, "UPDATE approvals SET status=?, updated_at=? WHERE id=?", [decision, now, approvalId]);
    await run(env.DB, "UPDATE tasks SET status=?, updated_at=? WHERE approval_id=?", [decision, now, approvalId]);
    let applyNote = "";
    if (decision === "approved") {
      const result = await applyChangeForApproval(env.DB, approvalId, String(cbq.from.id), null);
      applyNote = result.ok && result.appliedFields.length > 0
        ? ` · applied ${result.appliedFields.length} field(s)` : "";
    }
    await answerCallback(env, cbq.id, `Marked as ${decision}${applyNote}`);
  }
}

async function answerCallback(env: Env, callbackQueryId: string, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function sendMessage(
  env: Env,
  chatId: number,
  text: string,
  replyMarkup?: object,
  replyToMessageId?: number,
): Promise<void> {
  const payload: Record<string, unknown> = { chat_id: chatId, text, parse_mode: "HTML" };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  if (replyToMessageId) {
    payload.reply_to_message_id = replyToMessageId;
    payload.allow_sending_without_reply = true;
  }
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
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
          { text: "❌ Reject",  callback_data: `approval:${approvalId}:rejected`  },
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
// ── Photo / image → vision analysis ──────────────────────────────────────────

async function handlePhotoMessage(
  chatId: number,
  message: NonNullable<TelegramUpdate["message"]>,
  env: Env,
): Promise<void> {
  // Pick the largest photo size (Telegram sends multiple resolutions)
  const photos = message.photo ?? [];
  if (photos.length === 0) return;
  const largest = photos.reduce<typeof photos[0]>((best, p) =>
    (p.file_size ?? 0) > (best.file_size ?? 0) ? p : best, photos[0]!);
  if (!largest) return;

  const caption = message.caption?.trim() ?? "";
  await sendMessage(env, chatId, "📸 Image received — analysing with vision...");

  try {
    // 1. Get download path from Telegram
    const fileRes = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${largest.file_id}`,
    );
    const fileData = await fileRes.json<{ ok: boolean; result: { file_path: string } }>();
    if (!fileData.ok) {
      await sendMessage(env, chatId, "❌ Could not retrieve image from Telegram.");
      return;
    }

    // 2. Download image bytes
    const imgRes = await fetch(
      `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileData.result.file_path}`,
    );
    const imgBuffer = await imgRes.arrayBuffer();

    // Chunked base64 encoding — spreading large Uint8Array as args causes
    // "Maximum call stack size exceeded" on images > ~100KB.
    const uint8 = new Uint8Array(imgBuffer);
    let binary = "";
    const CHUNK = 8192;
    for (let i = 0; i < uint8.length; i += CHUNK) {
      binary += String.fromCharCode(...uint8.subarray(i, i + CHUNK));
    }
    const base64 = btoa(binary);

    // Infer media type from file path extension
    const ext = fileData.result.file_path.split(".").pop()?.toLowerCase() ?? "jpg";
    const mediaTypeMap: Record<string, string> = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
      gif: "image/gif", webp: "image/webp",
    };
    const mediaType = mediaTypeMap[ext] ?? "image/jpeg";

    // 3. Ask Claude to classify + analyse the image
    const userPrompt = caption
      ? `${caption}\n\nFirst classify this image into exactly one category: TRADING (options chain, brokerage screenshot, chart with ticker symbols, P&L data), DOCUMENT (contract, form, text-heavy page, email, message screenshot), PROPERTY (real estate photo, house/building exterior or interior, land), BUSINESS_DATA (non-trading chart, graph, spreadsheet, analytics dashboard), or GENERAL (everything else: personal photo, product, meme, etc.).\n\nThen provide a detailed analysis. If TRADING: extract symbols, strikes, expiry, Greeks, P&L. If DOCUMENT: transcribe key text and flag action items. If PROPERTY: describe condition, features, estimate ARV context. If BUSINESS_DATA: extract data points and trends. If GENERAL: describe what you see.`
      : "First classify this image into exactly one category: TRADING (options chain, brokerage screenshot, chart with ticker symbols, P&L data), DOCUMENT (contract, form, text-heavy page, email, message screenshot), PROPERTY (real estate photo, house/building exterior or interior, land), BUSINESS_DATA (non-trading chart, graph, spreadsheet, analytics dashboard), or GENERAL (everything else: personal photo, product, meme, etc.).\n\nThen provide a detailed analysis based on the category. For TRADING: extract all symbols, strikes, expiry dates, Greeks, and P&L. For DOCUMENT: transcribe key text and flag action items. For PROPERTY: describe condition, features, location clues. For BUSINESS_DATA: extract all data points. For GENERAL: describe what you see and any useful context.";

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-5",
        max_tokens: 1500,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64 },
            },
            { type: "text", text: userPrompt },
          ],
        }],
      }),
    });

    const claudeData = await claudeRes.json<{
      content?: Array<{ type: string; text?: string }>;
      error?: { message: string };
    }>();

    if (!claudeRes.ok || claudeData.error) {
      await sendMessage(env, chatId, `❌ Vision analysis error: ${claudeData.error?.message ?? "unknown"}`);
      return;
    }

    const visionText = claudeData.content?.find(b => b.type === "text")?.text ?? "(no analysis)";

    // 4. Detect image category from Claude's response, then route accordingly
    const categoryMatch = visionText.match(/\b(TRADING|DOCUMENT|PROPERTY|BUSINESS_DATA|GENERAL)\b/);
    const imageCategory = categoryMatch?.[1] ?? "GENERAL";

    // Map image category → agent routing
    const categoryRouting: Record<string, { teamId: string; agentId: string; kind: string; emoji: string }> = {
      TRADING:       { teamId: "team-finance",  agentId: "agent-finance-lead",             kind: "research",           emoji: "📈" },
      DOCUMENT:      { teamId: "team-research", agentId: "agent-research-lead",            kind: "research",           emoji: "📄" },
      PROPERTY:      { teamId: "team-agency",   agentId: "agent-agency-pipelineops",       kind: "lead_qualification", emoji: "🏠" },
      BUSINESS_DATA: { teamId: "team-intel",    agentId: "agent-intel-lead",               kind: "intel_review",       emoji: "📊" },
      GENERAL:       { teamId: "team-research", agentId: "agent-research-lead",            kind: "research",           emoji: "🖼️" },
    };

    const routing = categoryRouting[imageCategory] ?? categoryRouting["GENERAL"]!;

    // Self-learning keyboard varies by category
    const learnKeyboards: Record<string, object> = {
      TRADING: { inline_keyboard: [[
        { text: "📈 More chart analysis",  callback_data: `learn:${routing.agentId}:photo_interest:chart_analysis` },
        { text: "🎯 Options strategy",      callback_data: `learn:${routing.agentId}:photo_interest:options_strategy` },
        { text: "✓ Good",                   callback_data: `learn:${routing.agentId}:photo_interest:no_preference` },
      ]] },
      DOCUMENT: { inline_keyboard: [[
        { text: "📋 Extract action items",  callback_data: `learn:${routing.agentId}:photo_interest:action_items` },
        { text: "📝 Summarise contract",    callback_data: `learn:${routing.agentId}:photo_interest:contract_summary` },
        { text: "✓ Good",                   callback_data: `learn:${routing.agentId}:photo_interest:no_preference` },
      ]] },
      PROPERTY: { inline_keyboard: [[
        { text: "🏠 Run ARV estimate",      callback_data: `learn:${routing.agentId}:photo_interest:arv_estimate` },
        { text: "🔍 Research owner",        callback_data: `learn:${routing.agentId}:photo_interest:owner_research` },
        { text: "✓ Good",                   callback_data: `learn:${routing.agentId}:photo_interest:no_preference` },
      ]] },
      BUSINESS_DATA: { inline_keyboard: [[
        { text: "📊 Deep data analysis",    callback_data: `learn:${routing.agentId}:photo_interest:deep_analysis` },
        { text: "📉 Competitive intel",     callback_data: `learn:${routing.agentId}:photo_interest:competitive_intel` },
        { text: "✓ Good",                   callback_data: `learn:${routing.agentId}:photo_interest:no_preference` },
      ]] },
      GENERAL: { inline_keyboard: [[
        { text: "🔍 Research this",         callback_data: `learn:${routing.agentId}:photo_interest:research` },
        { text: "✓ Just info",              callback_data: `learn:${routing.agentId}:photo_interest:no_preference` },
      ]] },
    };

    const taskId = crypto.randomUUID();
    const now = new Date().toISOString();

    // For GENERAL with no caption — skip creating a task, just reply with analysis
    if (imageCategory === "GENERAL" && !caption) {
      await sendMessage(env, chatId,
        `${routing.emoji} <b>Image Analysis</b>\n\n${visionText.slice(0, 3500)}`
      );
      return;
    }

    // Create D1 task for all other categories
    await run(env.DB,
      `INSERT INTO tasks (id, kind, status, assigned_agent_id, team_id, input, telegram_chat_id, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      [taskId, routing.kind, routing.agentId, routing.teamId,
       JSON.stringify({
         summary: caption || `${imageCategory} image analysis`,
         details: visionText,
         source: "telegram_photo",
         image_category: imageCategory,
       }),
       chatId, now, now],
    );

    const learnKeyboard = learnKeyboards[imageCategory] ?? learnKeyboards["GENERAL"];

    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        parse_mode: "HTML",
        text:
          `${routing.emoji} <b>${imageCategory} — Vision Analysis</b>\n\n${visionText.slice(0, 900)}\n\n` +
          `🔄 Routing to <code>${routing.agentId}</code>\n<code>${taskId}</code>`,
        reply_markup: learnKeyboard,
      }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendMessage(env, chatId, `❌ Photo processing error: ${msg}`);
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
      `INSERT INTO tasks (id, kind, status, assigned_agent_id, team_id, input, telegram_chat_id, spawn_depth, created_at, updated_at)
       VALUES (?, 'intel_review', 'pending', 'agent-intel-lead', 'team-intel', ?, ?, 0, ?, ?)`,
      [
        taskId,
        JSON.stringify({
          summary: url,
          details: `Submitted via Telegram. Context: "${fullText.slice(0, 200)}". Repo: ${repoContext}`,
          source: "telegram_intel",
          url,
          ...(githubMatch ? { owner: githubMatch[1], repo: githubMatch[2] } : {}),
        }),
        chatId,
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
        body: JSON.stringify({ chat_id: chatId, text: intelText, parse_mode: "HTML" }) },
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

  const proposalType = (args[0] ?? "").toLowerCase();
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

// ── /targets — Price target commands ─────────────────────────────────────────
//
// /targets              → fresh targets for all watchlist symbols
// /targets AAPL         → fresh target for AAPL only
// /targets add NVDA     → add NVDA to watchlist then generate targets for it

async function handleTargetsCommand(chatId: number, args: string[], env: Env): Promise<void> {
  // /targets add SYMBOL
  if (args[0]?.toLowerCase() === "add") {
    const symbol = args[1]?.toUpperCase();
    if (!symbol) {
      await sendMessage(env, chatId, `Usage: <code>/targets add SYMBOL</code>\nExample: <code>/targets add NVDA</code>`);
      return;
    }

    // Add to watchlist (INSERT OR IGNORE in case it already exists)
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    await run(
      env.DB,
      `INSERT OR IGNORE INTO tws_watchlist (id, symbol, asset_type, notes, created_at, updated_at)
       VALUES (?, ?, 'equity', NULL, ?, ?)`,
      [id, symbol, now, now],
    );

    await sendMessage(env, chatId, `✅ <b>${symbol}</b> added to watchlist — generating targets…`);

    const targets = await generatePriceTargets(
      env.DB,
      {
        TRADING_URL: env.TRADING_URL,
        ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
        OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
      },
      [symbol],
    );

    if (targets.length === 0) {
      await sendMessage(env, chatId, `⚠️ Could not generate targets for <b>${symbol}</b> — check that the symbol is valid and the analysis service is available.`);
      return;
    }

    const msg = formatTargetsForTelegram(targets);
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "Markdown" }),
    });
    return;
  }

  // /targets AAPL — single symbol
  if (args.length > 0 && args[0]) {
    const symbol = args[0].toUpperCase();
    await sendMessage(env, chatId, `⏳ Analyzing <b>${symbol}</b>…`);

    const targets = await generatePriceTargets(
      env.DB,
      {
        TRADING_URL: env.TRADING_URL,
        ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
        OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
      },
      [symbol],
    );

    if (targets.length === 0) {
      // Fall back to stored targets
      const stored = await getStoredTargets(env.DB, symbol);
      if (stored.length > 0) {
        const msg = formatTargetsForTelegram([stored[0]!]);
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: msg + "\n\n_⚠️ Using cached data — live analysis unavailable_", parse_mode: "Markdown" }),
        });
      } else {
        await sendMessage(env, chatId, `⚠️ No targets available for <b>${symbol}</b>.`);
      }
      return;
    }

    const msg = formatTargetsForTelegram(targets);
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "Markdown" }),
    });
    return;
  }

  // /targets — all watchlist symbols
  // Determine watchlist count for progress message
  const watchlist = await query<{ symbol: string }>(
    env.DB,
    "SELECT symbol FROM tws_watchlist WHERE active=1 ORDER BY symbol ASC",
    [],
  );

  if (watchlist.length === 0) {
    await sendMessage(env, chatId,
      `📋 Watchlist is empty.\n\nAdd symbols first:\n<code>/targets add AAPL</code>`
    );
    return;
  }

  await sendMessage(env, chatId, `⏳ Analyzing ${watchlist.length} symbol${watchlist.length !== 1 ? "s" : ""}…`);

  const targets = await generatePriceTargets(
    env.DB,
    {
      TRADING_URL: env.TRADING_URL,
      ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
    },
  );

  if (targets.length === 0) {
    // Serve stored targets as fallback
    const stored = await getStoredTargets(env.DB);
    if (stored.length > 0) {
      const msg = formatTargetsForTelegram(stored);
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: msg + "\n\n_⚠️ Using cached data — live analysis unavailable_", parse_mode: "Markdown" }),
      });
    } else {
      await sendMessage(env, chatId, `⚠️ Could not generate price targets. Make sure TRADING_URL or OPENROUTER_API_KEY is configured.`);
    }
    return;
  }

  const msg = formatTargetsForTelegram(targets);
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: "Markdown" }),
  });
}

// ── /bailey — Bailey Group pipeline control ───────────────────────────────────

async function handleBaileyCommand(chatId: number, args: string[], env: Env): Promise<void> {
  const sub = args[0]?.toLowerCase();

  // /bailey status — show pipeline snapshot
  if (!sub || sub === "status") {
    const [pending, running, completed, failed, hot, warm] = await Promise.all([
      query<{ c: number }>(env.DB, `SELECT COUNT(*) as c FROM tasks WHERE kind='propstream_lead_score' AND status='pending'`, []),
      query<{ c: number }>(env.DB, `SELECT COUNT(*) as c FROM tasks WHERE kind='propstream_lead_score' AND status='running'`, []),
      query<{ id: string; output: string }>(env.DB,
        `SELECT id, output FROM tasks WHERE kind='propstream_lead_score' AND status='completed' ORDER BY updated_at DESC LIMIT 10`, []),
      query<{ c: number }>(env.DB, `SELECT COUNT(*) as c FROM tasks WHERE kind='propstream_lead_score' AND status='failed'`, []),
      query<{ c: number }>(env.DB, `SELECT COUNT(*) as c FROM tasks WHERE kind='seller_outbound_call' AND status='pending'`, []),
      query<{ c: number }>(env.DB, `SELECT COUNT(*) as c FROM tasks WHERE kind='seller_outbound_call' AND status='completed'`, []),
    ]);

    const completedList = completed.map((t) => {
      const out = JSON.parse(t.output ?? "{}") as { disposition?: string; score?: number };
      const emoji = out.disposition === "hot" ? "🔥" : out.disposition === "warm" ? "🟠" : "❄️";
      return `${emoji} ${out.disposition?.toUpperCase() ?? "?"} (${out.score ?? 0}/12) — ${t.id.slice(0, 8)}`;
    }).join("\n") || "  None yet";

    await sendMessage(env, chatId,
      `🏢 <b>Bailey Group Pipeline</b>\n\n` +
      `📥 Pending leads: ${(pending[0] as any)?.c ?? 0}\n` +
      `⚙️ Running: ${(running[0] as any)?.c ?? 0}\n` +
      `❌ Failed: ${(failed[0] as any)?.c ?? 0}\n\n` +
      `📞 Voice calls queued: ${(hot[0] as any)?.c ?? 0}\n` +
      `✅ Calls completed: ${(warm[0] as any)?.c ?? 0}\n\n` +
      `<b>Recent Scored Leads:</b>\n${completedList}\n\n` +
      `Commands:\n` +
      `<code>/bailey search</code> — trigger AI property search\n` +
      `<code>/bailey status</code> — this view`
    );
    return;
  }

  // /bailey search — trigger automated property search + ingest
  if (sub === "search") {
    await sendMessage(env, chatId, `🔍 Triggering Bailey Group property search via Perplexity…`);
    try {
      const workerUrl = "https://bot-nation-api.thejamalshackleford.workers.dev";
      const res = await fetch(`${workerUrl}/api/bailey/search-and-ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        const err = await res.text();
        await sendMessage(env, chatId, `❌ Search failed: ${res.status} — ${err.slice(0, 200)}`);
      } else {
        const result = await res.json() as { status: string; ingest_summary?: { new_leads: number; tasks_spawned: number } };
        await sendMessage(env, chatId,
          `✅ <b>Bailey Search Complete</b>\n\n` +
          `New leads found: ${result.ingest_summary?.new_leads ?? 0}\n` +
          `Tasks spawned: ${result.ingest_summary?.tasks_spawned ?? 0}\n\n` +
          `Leads will be auto-scored within 5 minutes.`
        );
      }
    } catch (err) {
      await sendMessage(env, chatId, `❌ Search error: ${String(err)}`);
    }
    return;
  }

  await sendMessage(env, chatId,
    `🏢 <b>Bailey Group Commands</b>\n\n` +
    `<code>/bailey status</code> — pipeline snapshot\n` +
    `<code>/bailey search</code> — AI property search + ingest`
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface TelegramUpdate {
  update_id?: number;
  message?: {
    message_id: number;
    text?: string;
    voice?: { file_id: string; duration: number };
    audio?: { file_id: string; duration: number };
    photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>;
    caption?: string;
    document?: { file_id: string; mime_type?: string; file_name?: string };
    chat: { id: number };
    from?: { id: number; username?: string };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number } };
    data?: string;
  };
}

// ── /setup finance — conversational setup wizard ──────────────────────────────
// State is stored in agent_notes under key `finance_setup_state_{chatId}`.
// Steps: account → max_contracts → stop_pct → target_pct → auto_execute → confirm

async function handleSetupCommand(chatId: number, args: string[], env: Env): Promise<void> {
  const sub = (args[0] ?? "").toLowerCase();

  if (sub !== "finance") {
    await sendMessage(env, chatId,
      `⚙️ <b>Setup Wizard</b>\n\nAvailable: <code>/setup finance</code> — configure your Finance Dept trading preferences`
    );
    return;
  }

  // Start fresh setup state
  const now = new Date().toISOString();
  await run(env.DB,
    `INSERT INTO agent_notes (id, agent_id, key, value, created_at, updated_at)
     VALUES (?, 'agent-finance-lead', ?, ?, ?, ?)
     ON CONFLICT(agent_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    [crypto.randomUUID(), `finance_setup_state_${chatId}`, JSON.stringify({ step: "account" }), now, now],
  );

  await sendMessage(env, chatId,
    `⚙️ <b>Finance Dept Setup</b>\n\n` +
    `Let's configure your trading preferences. I'll ask a few questions.\n\n` +
    `<b>Step 1 of 5 — Which Schwab account should trades execute in?</b>`,
    {
      inline_keyboard: [[
        { text: "📈 Individual (...749)",  callback_data: "setup_finance:account:749" },
        { text: "💰 Roth IRA (...105)",    callback_data: "setup_finance:account:105" },
      ], [
        { text: "👥 Joint Tenant (...266)", callback_data: "setup_finance:account:266" },
      ]],
    }
  );
}

// State machine: advance one step at a time
async function advanceFinanceSetup(chatId: number, step: string, value: string, env: Env): Promise<void> {
  const now = new Date().toISOString();
  const stateKey = `finance_setup_state_${chatId}`;

  // Load current state
  const stateRow = await queryOne<{ value: string }>(
    env.DB,
    `SELECT value FROM agent_notes WHERE agent_id='agent-finance-lead' AND key=?`,
    [stateKey],
  );
  const state = stateRow ? JSON.parse(stateRow.value) as Record<string, string> : {};

  // Save the answered step
  state[step] = value;

  const upsertState = async (s: Record<string, string>) => {
    await run(env.DB,
      `INSERT INTO agent_notes (id, agent_id, key, value, created_at, updated_at)
       VALUES (?, 'agent-finance-lead', ?, ?, ?, ?)
       ON CONFLICT(agent_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      [crypto.randomUUID(), stateKey, JSON.stringify(s), now, now],
    );
  };

  await upsertState(state);

  if (step === "account") {
    const labels: Record<string, string> = { "749": "Individual", "105": "Roth IRA", "266": "Joint Tenant" };
    await sendMessage(env, chatId,
      `✅ Account: <b>${labels[value] ?? value} (...${value})</b>\n\n` +
      `<b>Step 2 of 5 — Max contracts per trade?</b>\n` +
      `How many contracts at most per single order?`,
      {
        inline_keyboard: [[
          { text: "1 contract",  callback_data: "setup_finance:max_contracts:1" },
          { text: "2 contracts", callback_data: "setup_finance:max_contracts:2" },
          { text: "5 contracts", callback_data: "setup_finance:max_contracts:5" },
        ]],
      }
    );

  } else if (step === "max_contracts") {
    await sendMessage(env, chatId,
      `✅ Max contracts: <b>${value}</b>\n\n` +
      `<b>Step 3 of 5 — Stop-loss threshold?</b>\n` +
      `Close the position when the option mark reaches what % of your entry?`,
      {
        inline_keyboard: [[
          { text: "25% (tight)",    callback_data: "setup_finance:stop_pct:25" },
          { text: "35% (standard)", callback_data: "setup_finance:stop_pct:35" },
          { text: "50% (loose)",    callback_data: "setup_finance:stop_pct:50" },
        ]],
      }
    );

  } else if (step === "stop_pct") {
    await sendMessage(env, chatId,
      `✅ Stop-loss: <b>${value}% of entry</b>\n\n` +
      `<b>Step 4 of 5 — Profit target / roll trigger?</b>\n` +
      `Roll or take profit when the option gains what %?`,
      {
        inline_keyboard: [[
          { text: "100% (2×)",       callback_data: "setup_finance:target_pct:100" },
          { text: "180% (standard)", callback_data: "setup_finance:target_pct:180" },
          { text: "200% (patient)",  callback_data: "setup_finance:target_pct:200" },
        ]],
      }
    );

  } else if (step === "target_pct") {
    await sendMessage(env, chatId,
      `✅ Profit target: <b>${value}%</b>\n\n` +
      `<b>Step 5 of 5 — Auto-execute mode?</b>\n` +
      `Should Bot Nation execute trades automatically once the threshold is hit,\n` +
      `or always ask you first via Telegram?`,
      {
        inline_keyboard: [[
          { text: "🔔 Always ask me first (recommended)", callback_data: "setup_finance:auto_execute:ask" },
        ], [
          { text: "⚡ Auto-execute credits only (≤ $50 net debit)",  callback_data: "setup_finance:auto_execute:credits_only" },
          { text: "🤖 Auto-execute all (advanced)",                  callback_data: "setup_finance:auto_execute:all" },
        ]],
      }
    );

  } else if (step === "auto_execute") {
    // All steps answered — commit to agent_notes and activate Finance Dept
    const account   = state["account"]       ?? "749";
    const maxContr  = state["max_contracts"] ?? "1";
    const stopPct   = state["stop_pct"]      ?? "35";
    const targetPct = state["target_pct"]    ?? "180";
    const autoExec  = value;

    const autoLabel: Record<string, string> = {
      ask:           "Always ask first",
      credits_only:  "Auto-execute net credits only",
      all:           "Auto-execute all",
    };
    const acctLabel: Record<string, string> = { "749": "Individual", "105": "Roth IRA", "266": "Joint Tenant" };

    // Write all settings to agent_notes
    const settings: Array<[string, string]> = [
      ["default_account",   account],
      ["max_contracts",     maxContr],
      ["stop_loss_pct",     stopPct],
      ["profit_target_pct", targetPct],
      ["auto_execute",      autoExec],
      ["finance_setup_complete", "true"],
    ];

    for (const [key, val] of settings) {
      await run(env.DB,
        `INSERT INTO agent_notes (id, agent_id, key, value, created_at, updated_at)
         VALUES (?, 'agent-finance-lead', ?, ?, ?, ?)
         ON CONFLICT(agent_id, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
        [crypto.randomUUID(), key, val, now, now],
      );
    }

    // Clean up setup state
    await run(env.DB,
      `DELETE FROM agent_notes WHERE agent_id='agent-finance-lead' AND key=?`,
      [stateKey],
    );

    // Activate Finance Dept team in agents table
    await run(env.DB,
      `UPDATE agents SET status='active', updated_at=? WHERE id='agent-finance-lead'`,
      [now],
    );

    await sendMessage(env, chatId,
      `✅ <b>Finance Dept Activated!</b>\n\n` +
      `Here's your configuration:\n\n` +
      `🏦 <b>Account:</b> ${acctLabel[account] ?? account} (...${account})\n` +
      `📊 <b>Max contracts:</b> ${maxContr} per trade\n` +
      `🛑 <b>Stop-loss:</b> ${stopPct}% of entry (close when option hits ${stopPct}% of what you paid)\n` +
      `🎯 <b>Profit target:</b> ${targetPct}% gain → roll or take profit\n` +
      `⚡ <b>Auto-execute:</b> ${autoLabel[autoExec] ?? autoExec}\n\n` +
      `<b>Weekly schedule:</b>\n` +
      `• Sun 8 PM ET — weekly trade plan + entry recommendation\n` +
      `• Mon–Fri 8:30 AM ET — morning brief with position status\n` +
      `• Mon–Fri 4:30 PM ET — EOD wrap-up + exit check\n\n` +
      `Agent memory updated. Finance Dept is now <b>LIVE</b>.\n` +
      `Use <code>/finance</code> anytime to check status.`
    );
  }
}

// ── /finance — Finance Dept dashboard ─────────────────────────────────────────

async function handleFinanceCommand(chatId: number, args: string[], env: Env): Promise<void> {
  // Check if setup is complete
  const setupDone = await queryOne<{ value: string }>(
    env.DB,
    `SELECT value FROM agent_notes WHERE agent_id='agent-finance-lead' AND key='finance_setup_complete'`,
    [],
  );

  if (!setupDone?.value) {
    await sendMessage(env, chatId,
      `⚠️ <b>Finance Dept not yet configured</b>\n\nRun <code>/setup finance</code> to get started.`,
    );
    return;
  }

  // Load settings
  const [account, maxC, stop, target, autoExec] = await Promise.all([
    queryOne<{ value: string }>(env.DB, `SELECT value FROM agent_notes WHERE agent_id='agent-finance-lead' AND key='default_account'`, []),
    queryOne<{ value: string }>(env.DB, `SELECT value FROM agent_notes WHERE agent_id='agent-finance-lead' AND key='max_contracts'`, []),
    queryOne<{ value: string }>(env.DB, `SELECT value FROM agent_notes WHERE agent_id='agent-finance-lead' AND key='stop_loss_pct'`, []),
    queryOne<{ value: string }>(env.DB, `SELECT value FROM agent_notes WHERE agent_id='agent-finance-lead' AND key='profit_target_pct'`, []),
    queryOne<{ value: string }>(env.DB, `SELECT value FROM agent_notes WHERE agent_id='agent-finance-lead' AND key='auto_execute'`, []),
  ]);

  // Count pending orders
  const pendingOrders = await query<{ id: string; description: string; expires_at: string }>(
    env.DB,
    `SELECT id, description, expires_at FROM pending_orders
     WHERE status='pending_approval' AND expires_at > datetime('now')
     ORDER BY created_at DESC LIMIT 5`,
    [],
  );

  const acctLabel: Record<string, string> = { "749": "Individual", "105": "Roth IRA", "266": "Joint Tenant" };
  const acct = account?.value ?? "749";

  let pendingText = "";
  if (pendingOrders.length > 0) {
    pendingText = `\n\n⏳ <b>${pendingOrders.length} order(s) awaiting approval:</b>\n` +
      pendingOrders.map((o) =>
        `• ${o.description}\n  Expires: ${new Date(o.expires_at).toLocaleTimeString("en-US", { timeZone: "America/New_York" })} ET`
      ).join("\n");
  }

  await sendMessage(env, chatId,
    `◈ <b>Finance Dept Status</b>\n\n` +
    `🏦 Account: ${acctLabel[acct] ?? acct} (...${acct})\n` +
    `📊 Max contracts: ${maxC?.value ?? "1"}\n` +
    `🛑 Stop-loss: ${stop?.value ?? "35"}%\n` +
    `🎯 Profit target: ${target?.value ?? "180"}%\n` +
    `⚡ Auto-execute: ${autoExec?.value ?? "ask"}\n` +
    pendingText +
    `\n\n<i>Next brief: weekday 8:30 AM ET · Weekly plan: Sunday 8 PM ET</i>`,
    pendingOrders.length > 0 ? {
      inline_keyboard: [[
        { text: "📋 View pending orders", callback_data: "setup_finance:view_pending:all" },
        { text: "⚙️ Update settings",     callback_data: "setup_finance:restart:yes" },
      ]],
    } : {
      inline_keyboard: [[
        { text: "⚙️ Update settings", callback_data: "setup_finance:restart:yes" },
        { text: "📊 Run analysis now", callback_data: "setup_finance:run_analysis:now" },
      ]],
    }
  );
}

// ── /positions — live position snapshot ───────────────────────────────────────

async function handlePositionsCommand(chatId: number, env: Env): Promise<void> {
  const clientId     = env.SCHWAB_CLIENT_ID;
  const clientSecret = env.SCHWAB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    await sendMessage(env, chatId, `❌ Schwab credentials not configured`);
    return;
  }

  await sendMessage(env, chatId, `⏳ Fetching live positions from Schwab...`);

  try {
    const { syncPositions, getStoredPositions, fetchQuotes, formatPositionsForTelegram, calcPortfolioTotals } = await import("../services/schwab-positions");

    await syncPositions(env.DB, clientId, clientSecret);
    const { positions, accounts } = await getStoredPositions(env.DB);

    if (positions.length === 0) {
      await sendMessage(env, chatId, `📭 No positions found in Schwab account.`);
      return;
    }

    const symbols = [...new Set(positions.map((p) => p.symbol))];
    const quotes  = await fetchQuotes(env.DB, clientId, clientSecret, symbols);
    const totals  = calcPortfolioTotals(accounts, positions);

    const text = formatPositionsForTelegram(accounts, positions, quotes);
    await sendMessage(env, chatId, text);

    await sendMessage(env, chatId,
      `📊 <b>Portfolio Totals</b>\n` +
      `Total value: <b>$${totals.total_value.toFixed(2)}</b>\n` +
      `Day P&L: <b>${totals.total_day_pnl >= 0 ? "+" : ""}$${totals.total_day_pnl.toFixed(2)}</b>\n` +
      `Unrealized: <b>${totals.total_unrealized_pnl >= 0 ? "+" : ""}$${totals.total_unrealized_pnl.toFixed(2)}</b>`
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendMessage(env, chatId, `❌ Positions error: ${msg.slice(0, 300)}`);
  }
}
