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
}
