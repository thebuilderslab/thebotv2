/**
 * Nation Supervisor
 *
 * Central agent that handles all incoming Telegram messages.
 * - Classifies queries (simple, infrastructure, action)
 * - Generates responses or routes to appropriate teams
 * - Maintains conversation context via D1 chat memory
 * - Handles follow-up responses ("yes", "no") to previous questions
 */

import { classifyQuery, type QueryType, type ClassifiedQuery } from './query-classifier';
import { dispatchTextAsTask } from './dispatch-helper';
import { run } from '../db/schema';
import {
  listAllAgents,
  listAllTeams,
  getAgent,
  getTeam,
  AGENTS,
  TEAMS,
  DEPARTMENTS,
  ARCHITECTURE,
  SKILLS,
  TASK_TYPES,
} from './knowledge-base';
import { generateAnswer, generateResearch, formatAnswer, formatResearchResults } from './llm-service';
import { runResearch, formatResearchForTelegram } from './research-service';
import { findRelevantSkills, createSkillFromTask, formatSkillsForContext } from './skill-manager';
import { orchestrateResearch, synthesizeResults } from './microservice-orchestrator';
import {
  storeMessage,
  getRecentHistory,
  getLastAssistantMessage,
  formatHistoryAsMessages,
  isFollowUp,
  type ChatMessage,
} from './chat-memory';

export interface NationSupervisorResponse {
  type: 'direct_answer' | 'task_created' | 'clarification' | 'error';
  message: string;
  taskId?: string;
  queryType: QueryType;
  confidence: number;
  pendingAction?: string;
}

// ============================================================================
// Phase B-1: Specialist dispatch allow-list
// ============================================================================
// Tightly scoped per the B-1 plan ("avoid over-dispatch"). When the
// classifier flags a query with one of these specialist teams via
// suggestedTeam (regardless of type='simple' / 'infrastructure' / 'action'),
// handleMessage routes the query to that team's lead agent via
// dispatchTextAsTask instead of doing an inline LLM reply.
//
// Excluded by design: team-research (the catch-all default — would
// over-dispatch general-knowledge questions); team-build / team-infra
// (chat operators don't typically self-trigger code changes; those go
// through ACTION_PATTERNS). Add additional teams here only after their
// specialist-dispatch path is verified end-to-end.
const SPECIALIST_DISPATCH_ALLOWLIST = new Set<string>([
  'team-finance',
]);

// ============================================================================
// Main Handler
// ============================================================================

export async function handleMessage(
  userText: string,
  userId: number,
  chatId: number,
  env?: any,
): Promise<NationSupervisorResponse> {
  console.log(`[NationSupervisor] Processing message from ${userId}: "${userText}"`);

  const db = env?.DB as D1Database | undefined;
  const chatIdStr = String(chatId);
  const userIdStr = String(userId);

  // ── Store incoming user message ──────────────────────────────────────────
  if (db) {
    try {
      await storeMessage(db, {
        chat_id: chatIdStr,
        user_id: userIdStr,
        role: 'user',
        content: userText,
      });
    } catch (e) {
      console.warn('[NationSupervisor] Failed to store user message:', e);
    }
  }

  // ── Check for follow-up responses (yes/no/go ahead) ──────────────────────
  const followUp = isFollowUp(userText);
  if (followUp && db) {
    const lastAssistant = await getLastAssistantMessage(db, chatIdStr);
    if (lastAssistant?.pending_action) {
      console.log(`[NationSupervisor] Follow-up detected: ${followUp}, pending action: ${lastAssistant.pending_action}`);
      if (followUp === 'yes') {
        return await executeFollowUp(lastAssistant.pending_action, chatId, env, db);
      } else {
        return storeAndReturn(db, chatIdStr, userIdStr, {
          type: 'direct_answer',
          message: 'Alright, cancelled.',
          queryType: 'simple',
          confidence: 1,
        });
      }
    }
  }

  // ── Classify the query ───────────────────────────────────────────────────
  const classification = classifyQuery(userText);
  console.log(`[NationSupervisor] Classified as: ${classification.type} (${(classification.confidence * 100).toFixed(0)}%)`);

  // ── Phase B-1: specialist dispatch (R-DIR) ───────────────────────────────
  // If the classifier flagged a specialist team that's in the allow-list AND
  // the existing 'action' branch in routes/telegram.ts didn't already
  // handle it (i.e. type !== 'action'), dispatch the query to the
  // specialist agent via dispatchTextAsTask instead of dropping into an
  // inline LLM reply with no tools. The PR A1+A2+A3 delivery path then
  // delivers the real brief to chat as a follow-up message.
  //
  // type === 'action' is handled by routes/telegram.ts:205-348 BEFORE
  // handleMessage is invoked, so dispatching here would double-task. We
  // only dispatch for 'simple' and 'infrastructure' types.
  if (
    env?.DB &&
    classification.suggestedTeam &&
    SPECIALIST_DISPATCH_ALLOWLIST.has(classification.suggestedTeam) &&
    classification.type !== 'action'
  ) {
    try {
      const dispatch = await dispatchTextAsTask(env, chatId, userText, {
        userId,
        sendAck:       false,           // we send our own ack via the response below
        sourceLabel:   'supervisor_dispatch',
        forceTeam:     classification.suggestedTeam,
        forceTaskKind: classification.suggestedTaskKind ?? 'research',
      });

      if (dispatch.ok && dispatch.taskId && dispatch.agentId) {
        // Audit-trail event so the chat-driven dispatch path is observable
        // alongside the existing telegram.replay / schwab.* events.
        const now = new Date().toISOString();
        await run(
          env.DB,
          `INSERT INTO events (id, kind, actor_id, target_kind, target_id, payload, session_id, created_at, updated_at)
           VALUES (?, 'supervisor.dispatched', NULL, 'task', ?, ?, NULL, ?, ?)`,
          [
            crypto.randomUUID(),
            dispatch.taskId,
            JSON.stringify({
              targetAgent:   dispatch.agentId,
              taskKind:      classification.suggestedTaskKind ?? 'research',
              suggestedTeam: classification.suggestedTeam,
              classifiedAs:  classification.type,
              originalQuery: userText.slice(0, 200),
              chatId,
            }),
            now,
            now,
          ],
        ).catch((err) => {
          console.warn('[NationSupervisor] supervisor.dispatched event write failed:', err);
        });

        const ackMessage = `🤖 Dispatching to ${dispatch.agentId} — back in ~30s…\n<code>${dispatch.taskId}</code>`;
        const ackResponse: NationSupervisorResponse = {
          type:       'task_created',
          message:    ackMessage,
          queryType:  classification.type,
          confidence: classification.confidence,
          taskId:     dispatch.taskId,
        };
        if (db) {
          return storeAndReturn(db, chatIdStr, userIdStr, ackResponse);
        }
        return ackResponse;
      }

      // dispatchTextAsTask refused (e.g., trivial_reply / too_short). Fall
      // through to the existing handlers — don't fail the user-visible reply.
      console.log(`[NationSupervisor] Specialist dispatch declined: ${dispatch.reason ?? 'unknown'}`);
    } catch (err) {
      // Never fail the chat reply just because dispatch errored. Fall
      // through to the existing inline handlers.
      console.error('[NationSupervisor] Specialist dispatch threw:', err);
    }
  }

  // ── Get conversation history for context ─────────────────────────────────
  let history: ChatMessage[] = [];
  if (db) {
    try {
      history = await getRecentHistory(db, chatIdStr, 10);
    } catch (e) {
      console.warn('[NationSupervisor] Failed to get history:', e);
    }
  }

  // ── Route based on classification ────────────────────────────────────────
  let response: NationSupervisorResponse;

  switch (classification.type) {
    case 'infrastructure':
      response = await handleInfrastructureQuery(userText, classification, env, history);
      break;
    case 'action':
      response = await handleActionQuery(userText, classification, chatId, env, history);
      break;
    case 'simple':
    default:
      response = await handleSimpleQuery(userText, classification, env, history, db);
      break;
  }

  // ── Store outgoing assistant message ─────────────────────────────────────
  if (db) {
    return storeAndReturn(db, chatIdStr, userIdStr, response);
  }
  return response;
}

// ============================================================================
// Store helper
// ============================================================================

async function storeAndReturn(
  db: D1Database,
  chatId: string,
  userId: string,
  response: NationSupervisorResponse,
): Promise<NationSupervisorResponse> {
  try {
    await storeMessage(db, {
      chat_id: chatId,
      user_id: userId,
      role: 'assistant',
      content: response.message,
      query_type: response.queryType,
      task_id: response.taskId || undefined,
      pending_action: response.pendingAction || undefined,
    });
  } catch (e) {
    console.warn('[NationSupervisor] Failed to store assistant message:', e);
  }
  return response;
}

// ============================================================================
// Follow-up Execution
// ============================================================================

async function executeFollowUp(
  pendingAction: string,
  chatId: number,
  env: any,
  db?: D1Database,
): Promise<NationSupervisorResponse> {
  console.log(`[NationSupervisor] Executing follow-up action: ${pendingAction}`);

  // Parse the pending action (format: "action_type:details")
  const [actionType, ...detailParts] = pendingAction.split(':');
  const details = detailParts.join(':');

  switch (actionType) {
    case 'create_task': {
      // Execute the task that was proposed
      const findings = await generateResearch(details, env || {});
      const taskId = `task-${Date.now()}`;

      // Create skill from completed task
      if (db) {
        try {
          await createSkillFromTask(taskId, 'research', details, findings, db);
        } catch (e) {
          console.warn('[NationSupervisor] Failed to create skill from follow-up:', e);
        }
      }

      return {
        type: 'direct_answer',
        message: `Task Complete (${taskId})\n\n${findings}`,
        queryType: 'action',
        confidence: 1,
        taskId,
      };
    }
    default: {
      // Generic follow-up: re-run the query
      const findings = await generateResearch(details || pendingAction, env || {});
      const taskId = `task-${Date.now()}`;

      // Create skill from completed task
      if (db) {
        try {
          await createSkillFromTask(taskId, 'research', details || pendingAction, findings, db);
        } catch (e) {
          console.warn('[NationSupervisor] Failed to create skill from follow-up:', e);
        }
      }

      return {
        type: 'direct_answer',
        message: `Done (${taskId})\n\n${findings}`,
        queryType: 'action',
        confidence: 1,
        taskId,
      };
    }
  }
}

// ============================================================================
// Knowledge Base Context
// ============================================================================

function buildKnowledgeBaseContext(): string {
  const agentLines = Object.entries(AGENTS)
    .map(([id, a]) => `- ${a.name} (${id}), team: ${a.team || 'central'}, role: ${a.role}, capabilities: ${a.capabilities.join(', ')}`)
    .join('\n');

  const teamLines = Object.entries(TEAMS)
    .map(([id, t]) => `- ${t.name} (${id}), domain: ${t.domain}, lead: ${t.lead}, members: ${t.members.join(', ')}`)
    .join('\n');

  const deptLines = Object.entries(DEPARTMENTS)
    .map(([id, d]) => `- ${d.name} (${id}): ${d.description}. Teams: ${d.teams.length > 0 ? d.teams.join(', ') : 'none'}`)
    .join('\n');

  const skillLines = Object.entries(SKILLS)
    .map(([id, s]) => `- ${s.name} (${id}): ${s.description}. Agents: ${s.agents.join(', ')}. Status: ${(s as any).status || 'unknown'}`)
    .join('\n');

  const taskTypeLines = Object.entries(TASK_TYPES)
    .map(([id, t]) => `- ${t.name} (${id}): ${t.description}, team: ${t.team}, ETA: ${t.eta_seconds}s`)
    .join('\n');

  return `
BOT-NATION KNOWLEDGE BASE

TERMINOLOGY: "Teams" are the working units. "Departments" group related teams. When users say "dept" or "department", they mean the grouping. When they say "team", they mean the specific working unit. Use whichever term the user uses. Total: 16 agents, 9 teams, 6 departments.

AGENTS:
${agentLines}

TEAMS:
${teamLines}

DEPARTMENTS:
${deptLines}

SKILLS:
${skillLines}

TASK TYPES:
${taskTypeLines}

ARCHITECTURE:
- Platform: ${ARCHITECTURE.platform}
- Deployment: ${ARCHITECTURE.deployment}
- Components: ${Object.entries(ARCHITECTURE.components).map(([k, v]) => `${k}: ${v}`).join('; ')}
- Database: ${Object.entries(ARCHITECTURE.databases).map(([k, v]) => `${k}: ${v}`).join('; ')}

OPERATIONAL DATA:
- Bailey Group call lists, property addresses, and lead data are stored externally (CSV uploads, CRM).
- Nation Supervisor does NOT have direct access to call schedules or property data.
- To get operational data, create a task for the relevant team (e.g. agent-bailey-operations for call schedules).
  `.trim();
}

// ============================================================================
// Query Handlers
// ============================================================================

async function handleInfrastructureQuery(
  userText: string,
  classification: ClassifiedQuery,
  env?: any,
  history?: ChatMessage[],
): Promise<NationSupervisorResponse> {
  console.log('[NationSupervisor] Handling infrastructure query');

  const apiKey = env?.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return staticInfrastructureResponse(userText, classification);
  }

  try {
    const knowledgeBase = buildKnowledgeBaseContext();
    const historyMessages = history ? formatHistoryAsMessages(history.slice(-6)) : [];

    // Retrieve relevant skills from the skill manager
    let skillsContext = '';
    if (db) {
      try {
        const relevantSkills = await findRelevantSkills(userText, db, 2);
        skillsContext = formatSkillsForContext(relevantSkills);
      } catch (e) {
        console.warn('[NationSupervisor] Failed to load skills:', e);
      }
    }

    // Build messages array with history
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      ...historyMessages,
      { role: 'user', content: userText },
    ];

    // Dedupe: remove last entry if it duplicates userText (since history includes it)
    if (messages.length > 1 && messages[messages.length - 2]?.content === userText) {
      messages.splice(messages.length - 2, 1);
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: `You are Nation Supervisor, the central coordinator for Bot-Nation. Answer questions about our agents, teams, departments, skills, and architecture using ONLY the knowledge base below.\n\nRESPONSE STYLE: Terse. No filler, no articles, no pleasantries, no hedging. Short fragments OK. Technical substance must be exact. Drop "the", "a", "an", "I think", "certainly". Every token counts.\n\nFollow the user's formatting instructions exactly. Do not use markdown bold (**) — use plain text for Telegram. If the user refers to something from a previous message, use conversation history for context.\n\n${skillsContext}${knowledgeBase}`,
        messages,
      }),
    });

    if (!response.ok) {
      console.error(`[NationSupervisor] Infrastructure LLM error: ${response.status}`);
      return staticInfrastructureResponse(userText, classification);
    }

    const data = (await response.json()) as { content?: Array<{ text: string }> };
    const answer = data.content?.[0]?.text || 'Unable to generate response';

    return {
      type: 'direct_answer',
      message: answer,
      queryType: 'infrastructure',
      confidence: classification.confidence,
    };
  } catch (error) {
    console.error('[NationSupervisor] Infrastructure LLM error:', error);
    return staticInfrastructureResponse(userText, classification);
  }
}

function staticInfrastructureResponse(
  userText: string,
  classification: ClassifiedQuery,
): NationSupervisorResponse {
  const lowerText = userText.toLowerCase();
  if (/\bagent/.test(lowerText)) {
    return { type: 'direct_answer', message: `Bot-Nation Agents\n\n${listAllAgents()}`, queryType: 'infrastructure', confidence: classification.confidence };
  }
  if (/\bteam/.test(lowerText)) {
    return { type: 'direct_answer', message: `Bot-Nation Teams\n\n${listAllTeams()}`, queryType: 'infrastructure', confidence: classification.confidence };
  }
  return { type: 'direct_answer', message: `I can answer about agents, teams, departments, skills, and architecture.`, queryType: 'infrastructure', confidence: classification.confidence };
}

async function handleSimpleQuery(
  userText: string,
  classification: ClassifiedQuery,
  env?: any,
  history?: ChatMessage[],
  db?: D1Database,
): Promise<NationSupervisorResponse> {
  console.log('[NationSupervisor] Handling simple query with LLM');

  try {
    // Pass conversation history for context
    const apiKey = env?.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return { type: 'direct_answer', message: 'LLM not available.', queryType: 'simple', confidence: 0.5 };
    }

    // Retrieve relevant skills from the skill manager
    let skillsContext = '';
    if (db) {
      try {
        const relevantSkills = await findRelevantSkills(userText, db, 2);
        skillsContext = formatSkillsForContext(relevantSkills);
      } catch (e) {
        console.warn('[NationSupervisor] Failed to load skills:', e);
      }
    }

    const historyMessages = history ? formatHistoryAsMessages(history.slice(-6)) : [];
    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      ...historyMessages,
      { role: 'user', content: userText },
    ];

    if (messages.length > 1 && messages[messages.length - 2]?.content === userText) {
      messages.splice(messages.length - 2, 1);
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: `You are Nation Supervisor, the central coordinator for Bot-Nation. Answer the user's question concisely and accurately.\n\nRESPONSE STYLE: Terse. No filler, no articles, no pleasantries, no hedging. Short fragments OK. Technical substance must be exact. Drop "the", "a", "an", "I think", "certainly". Every token counts.\n\nUse conversation history for context. Do not use markdown bold (**). If the user is responding to a previous question you asked (like "yes" or "sure"), act on it using conversation context.\n\n${skillsContext}`,
        messages,
      }),
    });

    if (!response.ok) {
      const answer = await generateAnswer(userText, env || {});
      return { type: 'direct_answer', message: formatAnswer(answer, userText), queryType: 'simple', confidence: classification.confidence };
    }

    const data = (await response.json()) as { content?: Array<{ text: string }> };
    const answer = data.content?.[0]?.text || 'Unable to generate response';

    return {
      type: 'direct_answer',
      message: answer,
      queryType: 'simple',
      confidence: classification.confidence,
    };
  } catch (error) {
    console.error('[NationSupervisor] Error in simple query handler:', error);
    return { type: 'direct_answer', message: 'Sorry, I encountered an error.', queryType: 'simple', confidence: 0.5 };
  }
}

async function handleActionQuery(
  userText: string,
  classification: ClassifiedQuery,
  chatId: number,
  env?: any,
  history?: ChatMessage[],
): Promise<NationSupervisorResponse> {
  console.log('[NationSupervisor] Handling action query');

  const suggestedTeam = classification.suggestedTeam || 'team-research';
  const suggestedTaskKind = classification.suggestedTaskKind || 'research';
  const team = getTeam(suggestedTeam);
  const teamName = team?.name || suggestedTeam;
  const taskId = `task-${Date.now()}`;

  // Orchestrate research across all microservices in parallel
  if (suggestedTaskKind === 'research') {
    try {
      console.log(`[NationSupervisor] Orchestrating research for task ${taskId}`);
      const sources = await orchestrateResearch(userText, env);

      if (sources.length > 0) {
        console.log(`[NationSupervisor] Got ${sources.length} research sources`);
        const synthesis = synthesizeResults(sources);
        const fullMessage = `Task Complete (${taskId})\n\nType: ${suggestedTaskKind}\nTeam: ${teamName}\n\n${synthesis}`;

        // Create skill from successful research synthesis
        if (db) {
          try {
            await createSkillFromTask(taskId, suggestedTaskKind, userText, synthesis, db);
          } catch (e) {
            console.warn('[NationSupervisor] Failed to create skill:', e);
          }
        }

        return {
          type: 'direct_answer',
          message: fullMessage,
          queryType: 'action',
          confidence: classification.confidence,
          taskId,
        };
      }
    } catch (error) {
      console.error('[NationSupervisor] Orchestration error, falling back to LLM:', error);
    }
  }

  // Fallback to LLM research
  const apiKey = env?.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      console.log(`[NationSupervisor] Executing action task ${taskId} via LLM`);
      const findings = await generateResearch(userText, env);

      // Create skill from successful task
      if (db) {
        try {
          await createSkillFromTask(taskId, suggestedTaskKind, userText, findings, db);
        } catch (e) {
          console.warn('[NationSupervisor] Failed to create skill:', e);
        }
      }

      return {
        type: 'direct_answer',
        message: `Task Complete (${taskId})\n\nType: ${suggestedTaskKind}\nTeam: ${teamName}\n\n${findings}`,
        queryType: 'action',
        confidence: classification.confidence,
        taskId,
      };
    } catch (error) {
      console.error('[NationSupervisor] Action LLM error:', error);
    }
  }

  // Fallback with pending action for follow-up
  return {
    type: 'task_created',
    message: `Task Created (${taskId})\n\nType: ${suggestedTaskKind}\nTeam: ${teamName}\nStatus: Queued\n\nWould you like me to execute this now?`,
    queryType: 'action',
    confidence: classification.confidence,
    taskId,
    pendingAction: `create_task:${userText}`,
  };
}

// ============================================================================
// Exports
// ============================================================================

export function formatTelegramResponse(response: NationSupervisorResponse): string {
  return response.message;
}

export function logIncomingMessage(
  userId: number,
  chatId: number,
  text: string,
  classification: ClassifiedQuery,
) {
  console.log(`[NationSupervisor Audit] ${new Date().toISOString()} user=${userId} chat=${chatId} type=${classification.type} conf=${(classification.confidence * 100).toFixed(0)}% msg="${text.substring(0, 80)}"`);
}

export function logOutgoingResponse(
  chatId: number,
  response: NationSupervisorResponse,
) {
  console.log(`[NationSupervisor Response] ${new Date().toISOString()} chat=${chatId} type=${response.type} taskId=${response.taskId || 'N/A'}`);
}

// ── Persistent message logging ─────────────────────────────────────────────────
// Stores every in/out Telegram message in D1 for quality analysis + replay.
// Call from telegram.ts — fire-and-forget (never await in hot path).

export async function persistTelegramMessage(
  db: D1Database,
  direction: "in" | "out",
  chatId: number | string,
  text: string,
  options: {
    userId?: number | string;
    taskId?: string;
    routeType?: string;
    agentId?: string;
    messageId?: number;
  } = {},
): Promise<void> {
  const id  = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    const { run } = await import("../db/schema");
    await run(db,
      `INSERT INTO telegram_messages (id, direction, chat_id, user_id, text, task_id, route_type, agent_id, message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        direction,
        String(chatId),
        options.userId ? String(options.userId) : null,
        text.slice(0, 4000), // cap at 4000 chars
        options.taskId ?? null,
        options.routeType ?? null,
        options.agentId ?? null,
        options.messageId ?? null,
        now,
      ],
    );
  } catch (err) {
    // Never crash the main flow
    console.warn("[persistTelegramMessage] failed:", err);
  }

  // ── MEM-1: bridge to chat-memory unified surface ───────────────────────────
  // Phase B's first memory-layer fix. Every Telegram message persisted here
  // also lands in chat_messages so agents (which read via getRecentHistory
  // from chat-memory.ts) see the full conversation regardless of whether
  // the message went through the supervisor's inline handler or the action
  // dispatch path.
  //
  // Idempotency: storeMessage uses INSERT OR IGNORE; the partial UNIQUE
  // index added by migration 0043 (chat_id, telegram_message_id) ensures
  // that repeated calls with the same Telegram message ID create exactly
  // one row. Calls without options.messageId (rare — currently only the
  // dispatch-helper ack which doesn't yet have Telegram's response ID)
  // bypass the constraint and insert normally.
  //
  // Best-effort: any chat-memory write failure is swallowed and never
  // blocks the telegram_messages write above.
  try {
    const { storeMessage } = await import("./chat-memory");
    await storeMessage(db, {
      chat_id: String(chatId),
      user_id: options.userId
        ? String(options.userId)
        : (direction === "out" ? "system" : "unknown"),
      role:    direction === "in" ? "user" : "assistant",
      content: text.slice(0, 4000),
      task_id: options.taskId,
      telegram_message_id: options.messageId,
    });
  } catch (err) {
    // Best-effort: never let a chat-memory write failure block the main flow.
    console.warn("[persistTelegramMessage→chat-memory] failed:", err);
  }
}
