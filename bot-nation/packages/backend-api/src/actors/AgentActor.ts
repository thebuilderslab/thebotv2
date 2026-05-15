/**
 * AgentActor — Durable Object (Phase 7)
 *
 * One persistent DO instance per agent (keyed by agent_id).
 * Responsibilities:
 *   - Maintains a task queue across invocations
 *   - Executes tasks via OpenRouter (model-routed) or Anthropic fallback
 *   - Streams token chunks to connected WebSocket clients
 *   - Supports agent-to-agent messaging via DO stub calls
 *   - Uses alarms for immediate dispatch + 15-min execution timeout
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { query, queryOne, run } from "../db/schema";
import { executeTool } from "../services/tool-executor";
import { fetchQuotes, fetchOptionsChain, getStoredPositions, syncPositions, type OptionContract, type OptionsChainResult } from "../services/schwab-positions";
import { getAccessToken } from "../services/schwab-auth";
import { stagePendingOrder } from "../services/schwab-orders";
import { resolveModel, OPENROUTER_BASE_URL, OPENROUTER_APP_NAME, OPENROUTER_APP_URL } from "../services/model-router";
import {
  sanitiseInput,
  guardSpawn,
  checkGraphNodeCap,
  MAX_LOOP_ITERATIONS,
  MAX_DETAILS_LENGTH,
  makeGuardrailEvent,
} from "../services/guardrails";
import {
  storeMemory,
  recallMemories,
  formatMemoriesForPrompt,
  distillTaskOutput,
} from "../services/memory-service";
import { formatForTelegram, stripHtmlToPlain } from "../utils/telegram-format";
import {
  recordPositionSnapshot,
  compareMissedActions,
  getMissedActions,
  type PositionSnapshotRecord,
} from "../services/position-snapshot";
import { recordWatchlistSnapshot } from "../services/watchlist-snapshot";
import { matchChainRow, ChainRowNotFound } from "../services/chain-match";
import {
  evaluatePolicyDecision,
  getStoredThresholds,
  type PolicyThresholds,
} from "../services/policy-impact-model";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ActorEnv {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  BRAVE_SEARCH_API_KEY?: string;
  SEARXNG_BASE_URL?: string;
  AGENT_ACTOR: DurableObjectNamespace;
  OPENROUTER_API_KEY?: string;
  AI?: Ai;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  SCHWAB_CLIENT_ID?: string;
  SCHWAB_CLIENT_SECRET?: string;
}

interface QueuedTask {
  taskId: string;
  sessionId: string;
}

interface TaskRow {
  id: string;
  kind: string;
  input: string;
  output: string | null;
  parent_task_id: string | null;
  spawn_depth: number;
  telegram_chat_id: number | null;
  telegram_message_id: number | null;
  started_at: string | null;
  retry_count: number;
  max_retries: number;
  last_graph_node_id: string | null;
  assigned_agent_id: string | null;
  // ── Swarm handoff (migration 0026) ──────────────────────────────────────────
  handoff_to: string | null;       // agent this task is handing off to
  handoff_from: string | null;     // agent that handed off TO this task
  handoff_context: string | null;  // context blob at handoff time
  // ── LangGraph state snapshot (migration 0026) ────────────────────────────────
  state_snapshot: string | null;   // JSON checkpoint after each graph node
}

/** LangGraph-style state that flows through graph nodes */
interface GraphState {
  currentNodeId: string;
  prevOutput: string;
  visitedNodes: string[];
  nodeHistory: Array<{ id: string; output: string; ts: string }>;
  taskSummary: string;
}

// ── ETA lookup by task kind (seconds) ────────────────────────────────────────
const TASK_ETA_SECONDS: Record<string, number> = {
  research:             75,
  deep_research:       120,
  intel_review:        120,
  content_generation:   45,
  code_change:          60,
  improvement_proposal: 60,
  config_change:        45,
  wallet_simulation:    30,
  defi_plan:            90,
  defi_risk_check:      30,
  defi_health_monitor:  20,
  defi_report:          60,
  market_research:      60,
  campaign_generation:  30,
  lead_qualification:   45,
  crm_hygiene:          20,
};

function tgProgressBar(filled: number, total: number, width = 10): string {
  const n = Math.min(Math.round((filled / Math.max(total, 1)) * width), width);
  return `[${"█".repeat(n)}${"░".repeat(width - n)}]`;
}

interface AgentRow {
  id: string;
  name: string;
  role: string;
  domain: string;
  description: string | null;
  objectives: string | null;  // crewAI-style GOAL field
}

interface NoteRow {
  key: string;
  value: string;
}

interface ToolRow {
  name: string;
  description: string | null;
  schema: string | null;
}

interface GraphNode {
  id: string;
  kind: "llm_call" | "tool_call" | "spawn_agent" | "condition" | "end";
  prompt?: string;
  toolName?: string;
  targetAgentId?: string;
  label?: string;
  model?: string;   // optional per-node model override (e.g. fast classify node)
}

interface GraphEdge {
  from: string;
  to: string;
  condition: "always" | "on_success" | "on_failure" | string;
}

interface GraphDefinition {
  nodes: GraphNode[];
  edges: GraphEdge[];
  startNode: string;
}

interface GraphRow {
  id: string;
  definition: string;
}

interface ChildRow {
  id: string;
  kind: string;
  output: string | null;
}

// ── AgentActor ────────────────────────────────────────────────────────────────

export class AgentActor implements DurableObject {
  private state: DurableObjectState;
  private env: ActorEnv;
  private taskQueue: QueuedTask[] = [];
  private isRunning = false;

  constructor(state: DurableObjectState, env: ActorEnv) {
    this.state = state;
    this.env = env;

    // Restore queue and running state after hibernation
    this.state.blockConcurrencyWhile(async () => {
      const q = await this.state.storage.get<QueuedTask[]>("taskQueue");
      if (q) this.taskQueue = q;
      const r = await this.state.storage.get<boolean>("isRunning");
      if (r) this.isRunning = r;
    });
  }

  // ── HTTP routing ────────────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") return this.handleWebSocket(request);
    if (url.pathname === "/enqueue" && request.method === "POST") return this.handleEnqueue(request);
    if (url.pathname === "/status") return this.handleStatus();

    return new Response("Not Found", { status: 404 });
  }

  // ── WebSocket (hibernation-aware) ───────────────────────────────────────────

  private handleWebSocket(request: Request): Response {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      const msg = JSON.parse(typeof message === "string" ? message : "") as { type?: string };
      if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    } catch { /* ignore malformed messages */ }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    ws.close();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    ws.close();
  }

  // ── Task enqueueing ─────────────────────────────────────────────────────────

  private async handleEnqueue(request: Request): Promise<Response> {
    const item = await request.json<QueuedTask>();
    this.taskQueue.push(item);
    await this.state.storage.put("taskQueue", this.taskQueue);

    // Always set the alarm — drainQueue handles concurrency via isRunning.
    // If isRunning is stuck from a previous crashed execution, the alarm firing
    // will trigger the stale-lock recovery in drainQueue.
    await this.state.storage.setAlarm(Date.now() + 10);

    return Response.json({ queued: true, queueLength: this.taskQueue.length });
  }

  private handleStatus(): Response {
    return Response.json({
      isRunning: this.isRunning,
      queueLength: this.taskQueue.length,
      wsConnections: this.state.getWebSockets().length,
    });
  }

  // ── Alarm — drain task queue ────────────────────────────────────────────────

  async alarm(): Promise<void> {
    await this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    // Phase 1 Stability: Stale-lock recovery (30s re-alarm, not 5min)
    // If alarm fires while isRunning=true, the previous task timed out or
    // the DO was killed mid-execution. Retry the task (up to 3 times) with backoff.
    if (this.isRunning) {
      console.warn("[AgentActor] stale isRunning lock detected — retrying stuck task");
      this.isRunning = false;
      await this.state.storage.put("isRunning", false);

      // The stuck item should still be in memory or queued. Don't process it again
      // if the queue is already moving. Just reset the lock and let the alarm
      // fire again in 30s if still stuck.
      // Schedule recovery re-alarm: 30s (not 5min)
      await this.state.storage.setAlarm(Date.now() + 30 * 1000);
      return;
    }

    if (this.taskQueue.length === 0) return;

    this.isRunning = true;
    await this.state.storage.put("isRunning", true);

    const item = this.taskQueue.shift()!;
    await this.state.storage.put("taskQueue", this.taskQueue);

    // 15-minute execution timeout alarm (absolute deadline)
    await this.state.storage.setAlarm(Date.now() + 15 * 60 * 1000);

    try {
      await this.executeTask(item.taskId, item.sessionId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? (err.stack ?? "") : "";
      console.error(`[AgentActor] task ${item.taskId} FAILED (attempt): ${msg}`);

      // Load task to check retry count
      const task = await queryOne<TaskRow>(
        this.env.DB,
        "SELECT retry_count, max_retries FROM tasks WHERE id = ?",
        [item.taskId],
      );

      const retryCount = task?.retry_count ?? 0;
      const maxRetries = task?.max_retries ?? 3;

      if (retryCount < maxRetries) {
        // Re-queue with backoff: retry_count incremented
        console.warn(`[AgentActor] task ${item.taskId} will retry (${retryCount + 1}/${maxRetries})`);
        const now = new Date().toISOString();
        await run(
          this.env.DB,
          "UPDATE tasks SET retry_count=?, updated_at=? WHERE id=?",
          [retryCount + 1, now, item.taskId],
        );
        // Re-queue at front of queue (higher priority)
        this.taskQueue.unshift(item);
        await this.state.storage.put("taskQueue", this.taskQueue);
      } else {
        // Max retries exceeded — mark as failed
        console.error(`[AgentActor] task ${item.taskId} FAILED after ${maxRetries} retries`);
        const now = new Date().toISOString();
        await run(this.env.DB, "UPDATE tasks SET status='failed', updated_at=? WHERE id=?", [now, item.taskId]);
        await this.updateSession(item.sessionId, "failed", now);
        try {
          await this.emitEvent(item.taskId, "task.do_error", { error: msg, stack: stack.slice(0, 500) }, now);
        } catch { /* swallow */ }
        this.broadcast(JSON.stringify({ type: "error", taskId: item.taskId, message: msg }));
      }
    } finally {
      this.isRunning = false;
      await this.state.storage.put("isRunning", false);
      await this.state.storage.deleteAlarm();

      // More tasks queued? Schedule next immediately
      if (this.taskQueue.length > 0) {
        await this.state.storage.setAlarm(Date.now() + 10);
      }
    }
  }

  // ── Core execution ──────────────────────────────────────────────────────────

  private async executeTask(taskId: string, sessionId: string): Promise<void> {
    const now = new Date().toISOString();

    // Load task
    const task = await queryOne<TaskRow>(
      this.env.DB,
      "SELECT id, kind, input, output, parent_task_id, spawn_depth, telegram_chat_id, telegram_message_id, started_at, retry_count, max_retries, last_graph_node_id, assigned_agent_id, handoff_to, handoff_from, handoff_context, state_snapshot FROM tasks WHERE id = ?",
      [taskId],
    );
    if (!task) throw new Error(`Task ${taskId} not found`);

    // Load agent (derived from DO name = agent_id)
    const agentId = this.state.id.name;
    if (!agentId) throw new Error("AgentActor: DO must be keyed by agent_id (use idFromName)");
    const agent = await queryOne<AgentRow>(
      this.env.DB,
      "SELECT id, name, role, domain, description, objectives FROM agents WHERE id = ?",
      [agentId],
    );
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    // Load notes (agent_notes — key/value facts)
    const notes = await query<NoteRow>(
      this.env.DB,
      "SELECT key, value FROM agent_notes WHERE agent_id = ?",
      [agentId],
    );
    const notesText = notes.length > 0
      ? notes.map((n) => `${n.key}: ${n.value}`).join("\n")
      : "(no stored memory)";

    // Load long-term memories (MemPalace layer — distilled past task summaries)
    // Pass task summary as query → FTS5 relevance match (context-mode pattern):
    // finance agent asking about GOOGL recalls GOOGL memories, not real estate ones.
    const rawSummary = (() => { try { return (JSON.parse(task.input) as {summary?:string}).summary ?? ""; } catch { return ""; } })();
    const memories    = await recallMemories(this.env.DB, agentId, 6, rawSummary);
    const memoriesText = formatMemoriesForPrompt(memories);

    // Load default graph (if any)
    const graphRow = await queryOne<GraphRow>(
      this.env.DB,
      "SELECT id, definition FROM agent_graphs WHERE agent_id = ? AND is_default = 1 LIMIT 1",
      [agentId],
    );
    // code_change and config_change must bypass graph traversal — graph nodes don't enforce
    // tool_choice:"required", so GLM-5/Qwen graphs emit narrative instead of calling
    // submit_code_change. This mirrors the TOOL_FORCED_KINDS guard in flatToolLoop.
    const GRAPH_BYPASS_KINDS = new Set(["code_change", "config_change"]);
    const activeGraph = GRAPH_BYPASS_KINDS.has(task.kind) ? null : graphRow;

    // Parse task input
    let taskInput: { summary?: string; details?: string } = {};
    try { taskInput = JSON.parse(task.input) as typeof taskInput; } catch { /* ignore */ }

    // ── Guardrail 1: Input sanitisation ───────────────────────────────────────
    // summary = user-facing label → strict 2000-char limit (prompt injection protection)
    // details = internal system instructions → generous 20000-char limit (never truncate mission crons)
    const summaryGuard = sanitiseInput(taskInput.summary ?? "");
    const detailsGuard = sanitiseInput(taskInput.details ?? "", MAX_DETAILS_LENGTH);
    if (summaryGuard.flagged || detailsGuard.flagged) {
      const reasons = [...summaryGuard.reasons, ...detailsGuard.reasons];
      console.warn(`[Guardrail] Input flagged for task ${taskId}:`, reasons);
      await this.emitEvent(taskId, "guardrail.input_flagged",
        makeGuardrailEvent("input_sanitisation", reasons.join("; "), taskId), now);
    }
    taskInput = { summary: summaryGuard.safe, details: detailsGuard.safe };

    // Load child results (parent re-execution after spawn)
    const children = await query<ChildRow>(
      this.env.DB,
      "SELECT id, kind, output FROM tasks WHERE parent_task_id = ? ORDER BY created_at ASC",
      [taskId],
    );
    const childResultsText = children.length > 0
      ? children.map((c, i) => {
          let out: unknown = null;
          try { out = c.output ? JSON.parse(c.output) : null; } catch { out = c.output; }
          return `Child ${i + 1} (${c.kind}): ${JSON.stringify(out)}`;
        }).join("\n\n")
      : "";

    // Emit session.started
    await this.emitEvent(taskId, "session.started", { sessionId, agentId, graphId: activeGraph?.id ?? null }, now);
    await this.updateSession(sessionId, "running", now);
    this.broadcast(JSON.stringify({ type: "session_started", taskId, sessionId }));

    // Record started_at for elapsed time tracking
    const executionStartMs = Date.now();
    await run(this.env.DB, "UPDATE tasks SET started_at=? WHERE id=?", [now, taskId]);

    // Send initial ETA message to Telegram (only for tasks created from Telegram)
    const etaSeconds = TASK_ETA_SECONDS[task.kind] ?? 60;
    const totalGraphNodes = activeGraph
      ? (JSON.parse(activeGraph.definition) as GraphDefinition).nodes.filter((n) => n.kind !== "end").length
      : 1;
    await this.editTelegramProgress(task, 0, totalGraphNodes, 0, etaSeconds, "Starting...");

    let finalText = "";
    let artifactId: string | undefined;

    // Resolve model for this task
    const modelConfig = resolveModel(task.kind, agent.domain);
    this.broadcast(JSON.stringify({ type: "model_selected", model: modelConfig.model, taskKind: task.kind }));

    let promptTokens = 0;
    let completionTokens = 0;
    let providerUsed: "openrouter" | "anthropic" | "graph" = "graph";
    let actualModelUsed: string | undefined;

    if (activeGraph) {
      // ── Graph traversal ────────────────────────────────────────────────────
      const graph = JSON.parse(activeGraph.definition) as GraphDefinition;
      // Phase 1 Stability: Resume from checkpoint if retrying
      const resumeFromNodeId = task.retry_count > 0 && task.last_graph_node_id
        ? task.last_graph_node_id
        : null;
      if (resumeFromNodeId) {
        console.log(`[AgentActor] Resuming task ${taskId} from checkpoint: ${resumeFromNodeId}`);
      }
      const graphResult = await this.traverseGraph(graph, task, agent, notesText, memoriesText, childResultsText, taskId, sessionId, activeGraph.id, modelConfig, executionStartMs, etaSeconds, resumeFromNodeId);
      finalText = graphResult.text;
      promptTokens = graphResult.promptTokens;
      completionTokens = graphResult.completionTokens;
    } else {
      // ── Flat tool-use loop (fallback) ──────────────────────────────────────
      const loopResult = await this.flatToolLoop(task, agent, notesText, memoriesText, childResultsText, taskId, sessionId, modelConfig);
      finalText = loopResult.text;
      promptTokens = loopResult.promptTokens;
      completionTokens = loopResult.completionTokens;
      providerUsed = loopResult.provider;
      actualModelUsed = loopResult.actualModel;

      // Check for SPAWN_TASKS — only in flat loop mode; graph mode handles decomposition structurally.
      const spawnMatch = finalText.match(/<SPAWN_TASKS>\s*([\s\S]*?)\s*<\/SPAWN_TASKS>/);
      const spawnJson = spawnMatch?.[1];
      if (spawnMatch && spawnJson) {
        const spawned = await this.handleSpawn(spawnJson, taskId, agentId, now, task.spawn_depth);
        if (spawned) {
          await this.updateSession(sessionId, "completed", now);
          return;
        }
      }
    }

    // Store cost artifact — tracks token usage for billing / observability
    const costArtifactId = crypto.randomUUID();
    const modelUsed = activeGraph
      ? (JSON.parse(activeGraph.definition) as GraphDefinition).nodes[0]?.model ?? modelConfig.model
      : modelConfig.model;
    await run(
      this.env.DB,
      `INSERT INTO artifacts (id, kind, name, url, content, task_id, created_at, updated_at)
       VALUES (?, 'cost', ?, '', ?, ?, ?, ?)`,
      [
        costArtifactId,
        `${taskId}-cost`,
        JSON.stringify({ model: modelUsed, actualModel: actualModelUsed ?? modelUsed, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }),
        taskId, now, now,
      ],
    );
    await this.emitEvent(taskId, "task.cost_reported",
      {
        model: modelUsed,                                    // requested model
        actualModel: actualModelUsed ?? modelUsed,           // model the provider actually served (Bug 3 fix)
        provider: providerUsed,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
      new Date().toISOString());

    // ── Finance Lead: Record position snapshots & detect missed actions ────────
    // After agent completes, automatically record snapshots for all open positions
    // and detect threshold breaches compared to yesterday's decisions.
    //
    // A.6 (Layer 2): When `enable_greeks_enrichment` is on, fetch the Schwab options
    // chain row matching (underlying, strike, expiry, option_type) by EXACT MATCH and
    // populate delta/gamma/theta/vega/IV + underlying_price. On exact-match failure or
    // chain-API failure, the snapshot is still written with all Greek/IV fields NULL
    // and enrichment_failed=1. No fuzzy matching is performed under any circumstance.
    //
    // This block runs ONLY inside the AgentActor Finance Lead EOD branch, never in
    // interactive or ad-hoc flows.
    if (agentId === "agent-finance-lead") {
      try {
        const thresholds = await getStoredThresholds(this.env.DB, agentId);
        if (!thresholds) {
          console.warn("[AgentActor] Finance Lead thresholds not initialized; skipping snapshot recording");
        } else {
          // A.6: read enable_greeks_enrichment flag from agent_notes.feature_flags_json
          // Default to false when absent (per Config Source Precedence in plan §11).
          const enableEnrichment = await this.readFeatureFlag(agentId, "enable_greeks_enrichment");
          const haveSchwabSecrets = !!(this.env.SCHWAB_CLIENT_ID && this.env.SCHWAB_CLIENT_SECRET);

          // Load all open thinkorswim positions (has option-specific fields)
          const positions = await query<any>(
            this.env.DB,
            `SELECT id, symbol, strategy, side, option_type, strike, expiry, quantity, trade_price, mark, pl_open, pl_pct, days_to_expiry, status
             FROM tws_positions WHERE status = 'open' ORDER BY symbol`,
            [],
          );

          // A.6: prefetch one chain per unique underlying to minimise Schwab API calls.
          const chainByUnderlying: Map<string, OptionsChainResult> = new Map();
          if (enableEnrichment && haveSchwabSecrets) {
            const uniqueUnderlyings = [...new Set(positions
              .filter((p: any) => p.option_type) // option positions only
              .map((p: any) => (p.symbol ?? "").toUpperCase())
              .filter(Boolean))] as string[];
            for (const underlying of uniqueUnderlyings) {
              try {
                const chain = await fetchOptionsChain(
                  this.env.DB,
                  this.env.SCHWAB_CLIENT_ID!,
                  this.env.SCHWAB_CLIENT_SECRET!,
                  underlying,
                  { contractType: "ALL", strikeCount: 50 },
                );
                chainByUnderlying.set(underlying, chain);
              } catch (chainErr) {
                console.warn(`[AgentActor] fetchOptionsChain failed for ${underlying}:`, chainErr);
                await this.emitEvent(taskId, "enrichment.chain_failure", {
                  underlying,
                  error: chainErr instanceof Error ? chainErr.message : String(chainErr),
                }, new Date().toISOString());
                // Leave chainByUnderlying without this entry → per-position enrichment will fall through to failed path.
              }
            }
          }

          for (const pos of positions) {
            // Build position type from side + option type (e.g., LONG_CALL, SHORT_PUT)
            const posType = [pos.side, pos.option_type].filter(Boolean).join("_").toUpperCase() || "UNKNOWN";

            // A.6: exact-match the option position to a chain contract.
            // No fuzzy matching: exact strike, exact expiry, exact contract_type.
            let enrichedDelta: number | undefined = undefined;
            let enrichedGamma: number | undefined = undefined;
            let enrichedTheta: number | undefined = undefined;
            let enrichedVega: number | undefined = undefined;
            let enrichedIV: number | undefined = undefined;
            let enrichedUnderlying = 0;
            let enrichmentMethod: "schwab_chain" | "failed" | undefined = undefined;
            let enrichmentFailed: 0 | 1 = 0;

            if (enableEnrichment && pos.option_type) {
              const underlyingSym = (pos.symbol ?? "").toUpperCase();
              const chain = chainByUnderlying.get(underlyingSym);
              if (chain) {
                try {
                  const matched = matchChainRow(chain, {
                    strike: pos.strike,
                    expiry: pos.expiry,
                    contract_type: pos.option_type,
                  });
                  enrichedDelta = matched.delta;
                  enrichedGamma = matched.gamma;
                  enrichedTheta = matched.theta;
                  enrichedVega = matched.vega;
                  enrichedIV = matched.iv;
                  enrichedUnderlying = chain.underlying_price;
                  enrichmentMethod = "schwab_chain";
                  enrichmentFailed = 0;
                } catch (matchErr) {
                  enrichmentMethod = "failed";
                  enrichmentFailed = 1;
                  if (matchErr instanceof ChainRowNotFound) {
                    await this.emitEvent(taskId, "enrichment.match_missing", {
                      underlying: underlyingSym,
                      strike: pos.strike,
                      expiry: pos.expiry,
                      option_type: pos.option_type,
                    }, new Date().toISOString());
                  } else {
                    await this.emitEvent(taskId, "enrichment.match_error", {
                      underlying: underlyingSym,
                      error: matchErr instanceof Error ? matchErr.message : String(matchErr),
                    }, new Date().toISOString());
                  }
                }
              } else {
                // Chain fetch failed earlier; emit per-position failure marker.
                enrichmentMethod = "failed";
                enrichmentFailed = 1;
              }
            }

            // Map tws_positions to PolicyDecision Position interface
            const decision = evaluatePolicyDecision(
              {
                symbol: pos.symbol || "",
                position_type: posType,
                quantity: pos.quantity || 1,
                entry_price: pos.trade_price || 0,
                current_price: pos.mark || 0,
                days_to_expiry: pos.days_to_expiry || 0,
                underlying_price: enrichedUnderlying,
                pnl_pct: (pos.pl_pct || 0),
              },
              thresholds,
            );

            const snapshot: PositionSnapshotRecord = {
              agent_id: agentId,
              symbol: pos.symbol || "",
              position_type: posType,
              quantity: pos.quantity || 1,
              entry_price: pos.trade_price || 0,
              current_price: pos.mark || 0,
              current_pnl_pct: pos.pl_pct || 0,
              days_to_expiry: pos.days_to_expiry || 0,
              delta: enrichedDelta,
              gamma: enrichedGamma,
              theta: enrichedTheta,
              vega: enrichedVega,
              implied_volatility: enrichedIV,
              underlying_price: enrichedUnderlying,
              policy_decision: decision.action,
              decision_rationale: decision.rationale,
              thresholds_at_snapshot: thresholds,
              snapshot_type: "daily",
              enrichment_method: enrichmentMethod,
              enrichment_failed: enrichmentFailed,
            };
            await recordPositionSnapshot(this.env.DB, snapshot);
          }

          // A.6: watchlist snapshots — one row per active tws_watchlist symbol per EOD.
          if (enableEnrichment && haveSchwabSecrets) {
            try {
              const watchlist = await query<{ symbol: string }>(
                this.env.DB,
                "SELECT symbol FROM tws_watchlist WHERE active = 1 ORDER BY symbol",
                [],
              );
              const wlSymbols = watchlist.map((w) => (w.symbol ?? "").toUpperCase()).filter(Boolean);
              if (wlSymbols.length > 0) {
                const quotes = await fetchQuotes(
                  this.env.DB,
                  this.env.SCHWAB_CLIENT_ID!,
                  this.env.SCHWAB_CLIENT_SECRET!,
                  wlSymbols,
                );
                const wlNow = new Date().toISOString();
                for (const q of quotes) {
                  await recordWatchlistSnapshot(this.env.DB, {
                    symbol: q.symbol,
                    close_price: q.last_price,
                    volume: q.volume ?? null,
                    recorded_at: wlNow,
                  });
                }
              }
            } catch (wlErr) {
              console.warn(`[AgentActor] watchlist enrichment failed:`, wlErr);
              await this.emitEvent(taskId, "enrichment.quotes_failure", {
                error: wlErr instanceof Error ? wlErr.message : String(wlErr),
              }, new Date().toISOString());
            }
          }

          // Detect missed actions by comparing today vs yesterday
          const today = new Date().toISOString().split("T")[0];
          const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];

          let allMissedActions: any[] = [];
          for (const pos of positions) {
            const missed = await getMissedActions(
              this.env.DB,
              `${yesterday}T00:00:00Z`,
              `${today}T23:59:59Z`,
              pos.symbol,
            );
            allMissedActions = allMissedActions.concat(missed);
          }

          if (allMissedActions.length > 0) {
            const missedActionsSummary = `\n\n📊 <b>MISSED ACTIONS DETECTED:</b>\n${allMissedActions.map((m) => `• ${m.symbol} (${m.missed_action_type}): ${m.notes}`).join("\n")}`;
            finalText += missedActionsSummary;
          }
        }
      } catch (snapErr) {
        console.warn(`[AgentActor] Position snapshot recording failed for task ${taskId}:`, snapErr);
        // Never crash — task completes with or without snapshots
      }
    }

    // Store response artifact
    artifactId = crypto.randomUUID();
    const artifactContent = JSON.stringify({ response: finalText });
    await run(
      this.env.DB,
      `INSERT INTO artifacts (id, kind, name, url, content, task_id, created_at, updated_at)
       VALUES (?, 'log', ?, '', ?, ?, ?, ?)`,
      [artifactId, `${taskId}-output`, artifactContent, taskId, now, now],
    );

    // Mark task completed
    const outputJson = JSON.stringify({ summary: finalText.slice(0, 200), artifactIds: [artifactId] });
    await run(
      this.env.DB,
      "UPDATE tasks SET status='completed', output=?, session_id=?, updated_at=? WHERE id=?",
      [outputJson, sessionId, now, taskId],
    );

    // ── Self-critique — Microsoft ai-agents-for-beginners pattern ────────────
    // Single lightweight LLM call to catch vague/incomplete answers before they
    // hit Telegram. Only for user-facing, content-heavy task kinds.
    // ~$0.001 per call (Gemini Flash); adds ~10s; skipped on failure/timeout.
    const CRITIQUE_KINDS = new Set(["research", "deep_research", "intel_review", "content_generation", "market_research", "intel_check"]);
    if (task.telegram_chat_id && CRITIQUE_KINDS.has(task.kind) && finalText.length > 200) {
      try {
        const rewritten = await this.selfCritique(finalText, task.kind);
        if (rewritten) {
          finalText = rewritten;
          // Update the artifact + task output with the improved text
          await run(this.env.DB,
            "UPDATE artifacts SET content=? WHERE id=?",
            [JSON.stringify({ response: finalText }), artifactId],
          );
          await run(this.env.DB,
            "UPDATE tasks SET output=? WHERE id=?",
            [JSON.stringify({ summary: finalText.slice(0, 200), artifactIds: [artifactId], critique: "rewritten" }), taskId],
          );
        }
      } catch (critiqueErr) {
        console.warn(`[AgentActor] Self-critique failed for task ${taskId}:`, critiqueErr);
        // Never crash — original finalText is used
      }
    }

    // ── MemPalace: distill task result into long-term memory ──────────────────
    // Skip low-signal task kinds (spawned sub-tasks) to keep memory clean.
    const skipMemoryKinds = new Set(["config_change"]);
    if (!skipMemoryKinds.has(task.kind) && finalText.length > 50) {
      try {
        const taskSummaryText = typeof taskInput === "object" && taskInput.summary
          ? String(taskInput.summary)
          : task.kind;
        const distilled = distillTaskOutput(task.kind, taskSummaryText, finalText);
        await storeMemory(this.env.DB, agentId, distilled.summary, {
          taskId,
          importance: distilled.importance,
          tags: distilled.tags,
          sourceKind: "task",
        });
      } catch (memErr) {
        // Memory storage failure must never crash the task
        console.warn(`[AgentActor] Memory store failed for task ${taskId}:`, memErr);
      }
    }

    const completedAt = new Date().toISOString();
    await this.emitEvent(taskId, "session.completed", { sessionId, artifactId }, completedAt);
    await this.updateSession(sessionId, "completed", completedAt);
    this.broadcast(JSON.stringify({ type: "completed", taskId, summary: finalText.slice(0, 200) }));

    // Send Telegram completion notification
    const elapsedSeconds = Math.round((Date.now() - executionStartMs) / 1000);
    await this.editTelegramCompletion(task, elapsedSeconds, finalText);
  }

  // ── Graph traversal ─────────────────────────────────────────────────────────

  private async traverseGraph(
    graph: GraphDefinition,
    task: TaskRow,
    agent: AgentRow,
    notesText: string,
    memoriesText: string,
    childResultsText: string,
    taskId: string,
    sessionId: string,
    graphId: string,
    modelConfig: { model: string; fallback: string; maxTokens: number; temperature: number },
    executionStartMs = Date.now(),
    etaSeconds = 60,
    resumeFromNodeId: string | null = null,
  ): Promise<{ text: string; promptTokens: number; completionTokens: number }> {
    const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));

    // ── LangGraph state: load snapshot or init fresh ──────────────────────────
    let taskInput: { summary?: string; details?: string } = {};
    try { taskInput = JSON.parse(task.input) as typeof taskInput; } catch { /* ignore */ }
    const taskSummary = taskInput.summary ?? task.input ?? "";

    let graphState: GraphState = {
      currentNodeId: graph.startNode,
      prevOutput: childResultsText || taskSummary,
      visitedNodes: [],
      nodeHistory: [],
      taskSummary,
    };

    // Restore from snapshot if available (LangGraph checkpoint resume)
    if (task.state_snapshot) {
      try {
        const snap = JSON.parse(task.state_snapshot) as Partial<GraphState>;
        if (snap.currentNodeId && nodeMap.has(snap.currentNodeId)) {
          graphState = { ...graphState, ...snap };
          console.log(`[AgentActor] Resumed from LangGraph snapshot at node ${graphState.currentNodeId}`);
        }
      } catch { /* bad snapshot — start fresh */ }
    } else if (resumeFromNodeId) {
      // Legacy checkpoint: jump to node after resume point
      const resumeNode = nodeMap.get(resumeFromNodeId);
      if (resumeNode) {
        const edge = graph.edges.find((e) => e.from === resumeFromNodeId);
        graphState.currentNodeId = edge?.to ?? "";
        console.log(`[AgentActor] Legacy resume to node ${graphState.currentNodeId}`);
      }
    }

    let currentNodeId = graphState.currentNodeId;
    let prevOutput    = graphState.prevOutput;
    let lastText = "";

    const systemPrompt = this.buildSystemPrompt(agent, notesText, memoriesText);
    // Graph LLM nodes do NOT receive tools — tool invocation uses dedicated tool_call nodes.
    // Passing tools to streaming LLM nodes causes agentic models (Kimi, GLM) to call tools
    // mid-stream, which the streaming path cannot handle.
    const now = new Date().toISOString();
    let nodesExecuted = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;

    while (currentNodeId) {
      // ── Guardrail 4: Graph node execution cap ──────────────────────────────
      if (!checkGraphNodeCap(nodesExecuted)) {
        console.warn(`[Guardrail] Graph node cap reached for task ${taskId} after ${nodesExecuted} nodes`);
        await this.emitEvent(taskId, "guardrail.graph_cap",
          makeGuardrailEvent("graph_node_cap", `Stopped after ${nodesExecuted} nodes`, taskId), now);
        break;
      }
      nodesExecuted++;

      const node = nodeMap.get(currentNodeId);
      if (!node || node.kind === "end") break;

      // ── LangGraph cycle detection ────────────────────────────────────────────
      // If we've visited this node before, the graph has a cycle — abort to prevent
      // infinite loops. (LangGraph raises StateGraph errors for unguarded cycles.)
      if (graphState.visitedNodes.includes(currentNodeId)) {
        console.warn(`[LangGraph] Cycle detected at node ${currentNodeId} in task ${taskId} — breaking`);
        await this.emitEvent(taskId, "guardrail.graph_cycle",
          makeGuardrailEvent("graph_cycle", `Cycle at node ${currentNodeId}`, taskId), now);
        break;
      }
      graphState.visitedNodes.push(currentNodeId);

      let nodeOutput = "";
      let nodeOk = true;

      this.broadcast(JSON.stringify({ type: "node_start", nodeId: node.id, label: node.label ?? node.id }));

      if (node.kind === "llm_call") {
        const prompt = (node.prompt ?? "Continue: {{prev}}")
          .replace("{{prev}}", prevOutput)
          .replace("{{task}}", taskSummary);
        // Allow per-node model override (e.g. Gemini Flash for classify nodes)
        const nodeModelConfig = node.model
          ? { ...modelConfig, model: node.model }
          : modelConfig;
        const llmResult = await this.streamingLlmCall(systemPrompt, prompt, [], nodeModelConfig);
        nodeOutput = llmResult.text;
        totalPromptTokens += llmResult.promptTokens;
        totalCompletionTokens += llmResult.completionTokens;
        lastText = nodeOutput;
      } else if (node.kind === "tool_call" && node.toolName) {
        const toolInput: Record<string, unknown> = { query: prevOutput, message: prevOutput };
        const result = await executeTool(this.env.DB, { searxngBaseUrl: this.env.SEARXNG_BASE_URL, braveApiKey: this.env.BRAVE_SEARCH_API_KEY }, node.toolName, toolInput);
        nodeOutput = JSON.stringify(result.result ?? result.error);
        nodeOk = result.ok;
        this.broadcast(JSON.stringify({ type: "tool_result", toolName: node.toolName, ok: result.ok }));
      } else if (node.kind === "spawn_agent" && node.targetAgentId) {
        await this.sendToAgent(node.targetAgentId, taskId, sessionId);
        nodeOutput = `Delegated to agent ${node.targetAgentId}`;
      }

      await this.emitEvent(taskId, "session.node_completed", {
        sessionId, graphId, nodeId: node.id, ok: nodeOk,
      }, now);

      // ── LangGraph state snapshot: write full state after each node ────────────
      // This lets retries resume exactly from the last successful node, with full
      // prevOutput context — not just the node ID.
      graphState.prevOutput    = nodeOutput || prevOutput;
      graphState.nodeHistory.push({ id: node.id, output: nodeOutput.slice(0, 300), ts: now });
      // Peek at next node for the snapshot's currentNodeId
      const nextEdgeForSnap = graph.edges.find((e) => e.from === currentNodeId && e.condition === "always");
      graphState.currentNodeId = nextEdgeForSnap?.to ?? currentNodeId;

      const snapshot = JSON.stringify({
        currentNodeId: graphState.currentNodeId,
        prevOutput:    graphState.prevOutput.slice(0, 1000),   // cap snapshot size
        visitedNodes:  graphState.visitedNodes,
        nodeHistory:   graphState.nodeHistory.slice(-10),      // last 10 nodes
        taskSummary:   graphState.taskSummary,
      });

      await run(this.env.DB,
        "UPDATE tasks SET last_graph_node_id=?, state_snapshot=? WHERE id=?",
        [node.id, snapshot, taskId],
      );

      // Send Telegram progress update after each node
      const elapsedSec = Math.round((Date.now() - executionStartMs) / 1000);
      const totalNodes = graph.nodes.filter((n) => n.kind !== "end").length;
      await this.editTelegramProgress(task, nodesExecuted, totalNodes, elapsedSec, etaSeconds, node.label ?? node.id);

      const edge = graph.edges.find((e) => {
        if (e.from !== currentNodeId) return false;
        if (e.condition === "always") return true;
        if (e.condition === "on_success") return nodeOk;
        if (e.condition === "on_failure") return !nodeOk;
        // Content-based branch: "contains:KEYWORD" — matches if prevOutput includes KEYWORD
        if (e.condition.startsWith("contains:")) {
          const keyword = e.condition.slice("contains:".length);
          return nodeOutput.toUpperCase().includes(keyword.toUpperCase());
        }
        return false;
      });

      currentNodeId = edge?.to ?? "";
      prevOutput = nodeOutput;
    }

    return { text: lastText || prevOutput, promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens };
  }

  // ── Flat tool-use loop (no graph) ───────────────────────────────────────────

  private async flatToolLoop(
    task: TaskRow,
    agent: AgentRow,
    notesText: string,
    memoriesText: string,
    childResultsText: string,
    taskId: string,
    _sessionId: string,
    modelConfig: { model: string; fallback: string; maxTokens: number; temperature: number },
  ): Promise<{ text: string; promptTokens: number; completionTokens: number; provider: "openrouter" | "anthropic"; actualModel?: string }> {
    let taskInput: { summary?: string; details?: string } = {};
    try { taskInput = JSON.parse(task.input) as typeof taskInput; } catch { /* ignore */ }

    const systemPrompt = this.buildSystemPrompt(agent, notesText, memoriesText);

    // ── Market data pre-fetch for finance/trading tasks ───────────────────────
    // Inject live Yahoo Finance prices so agent never outputs "data unavailable".
    let marketContext = "";
    const isFinanceTask =
      agent.id === "agent-finance-lead" ||
      task.assigned_agent_id === "agent-finance-lead" ||
      /finance|trading|morning_trading|midday_trading|eod_wrap/i.test(task.kind);

    if (isFinanceTask) {
      marketContext = await this.fetchMarketContext();
    }

    const userMessage = [
      marketContext ? `[Live Market Data — ${new Date().toUTCString()}]\n${marketContext}\n\n` : "",
      childResultsText ? `[Sub-task results]\n${childResultsText}\n\n` : "",
      `Task: ${taskInput.summary ?? ""}`,
      taskInput.details ? `\n\n${taskInput.details}` : "",
      childResultsText ? "\n\nSynthesize the sub-task results into a final structured report." : "",
    ].join("").trim();

    const toolRows = await query<ToolRow>(
      this.env.DB,
      "SELECT name, description, schema FROM tools WHERE status = 'active'",
      [],
    );

    // ── Inject query_db introspection tool — always available, not in DB ───────
    // Prevents agents from hallucinating task IDs, counts, or agent states.
    const introspectionToolRow: ToolRow = {
      name: "query_db",
      description: "Query live bot-nation system state. Use this BEFORE answering questions about tasks, agents, costs, or proposals — never guess. Pass { view: string, agent_id?: string }.",
      schema: JSON.stringify({
        type: "object",
        properties: {
          view: {
            type: "string",
            enum: ["my_tasks", "my_notes", "system_health", "active_crons", "pending_proposals", "agents", "recent_failures", "my_cost_today"],
            description: "Which data view to query",
          },
          agent_id: {
            type: "string",
            description: "Your agent ID (required for my_tasks, my_notes, my_cost_today)",
          },
        },
        required: ["view"],
      }),
    };
    const allToolRows = [introspectionToolRow, ...toolRows];
    const openaiTools = this.buildOpenAITools(allToolRows);
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "user", content: userMessage },
    ];
    let finalText = "";
    let iterations = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    // Bug 3 fix (Apr 2026): cost_reported.model previously echoed the *requested*
    // OpenRouter slug even when the call actually fell through to Anthropic. Capture
    // what the provider says it served us and return that as actualModel so the
    // event truthfully reflects the served model.
    let actualModel: string | undefined;

    // Use OpenRouter if key available, else fall back to Anthropic.
    // EXCEPTION: code_change/config_change/intel_review must use Anthropic directly —
    // OpenRouter's pass-through to Kimi/Qwen/GLM does not reliably honor
    // tool_choice:"required", so models emit text instead of calling tools.
    // Claude (Anthropic SDK) is the most reliable for forced tool use.
    const TOOL_FORCED_KINDS = new Set(["code_change", "config_change", "intel_review"]);
    const useOpenRouter = !!this.env.OPENROUTER_API_KEY && !TOOL_FORCED_KINDS.has(task.kind);

    if (useOpenRouter) {
      const client = new OpenAI({
        baseURL: OPENROUTER_BASE_URL,
        apiKey: this.env.OPENROUTER_API_KEY!,
        defaultHeaders: {
          "HTTP-Referer": OPENROUTER_APP_URL,
          "X-Title": OPENROUTER_APP_NAME,
        },
      });

      // ── Guardrail 5: Loop iteration cap ─────────────────────────────────────
      // ── Guardrail 6: Submit-without-read protection (OpenRouter loop) ──────
      const orReadPaths = new Set<string>();
      while (iterations < MAX_LOOP_ITERATIONS) {
        iterations++;
        // Force a tool call on the first iteration of code_change tasks —
        // without this, models tend to describe the change in text instead of calling tools.
        const toolChoice =
          openaiTools.length > 0 && task.kind === "code_change" && iterations === 1
            ? ("required" as const)
            : ("auto" as const);

        const response = await client.chat.completions.create({
          model: modelConfig.model,
          max_tokens: modelConfig.maxTokens,
          temperature: modelConfig.temperature,
          messages: [{ role: "system", content: systemPrompt }, ...messages],
          ...(openaiTools.length > 0 ? { tools: openaiTools, tool_choice: toolChoice } : {}),
        });

        const choice = response.choices[0];
        const msg = choice?.message;
        const stopReason = choice?.finish_reason;
        totalPromptTokens += response.usage?.prompt_tokens ?? 0;
        totalCompletionTokens += response.usage?.completion_tokens ?? 0;
        // OpenRouter echoes the actually-served model (may differ from requested
        // when fallbacks kick in). Bug 3 fix (Apr 2026).
        if (response.model) actualModel = response.model;

        if (stopReason === "stop") {
          finalText = msg?.content ?? "";
          break;
        }

        if (stopReason === "tool_calls" && msg?.tool_calls?.length) {
          messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
          for (const tc of msg.tool_calls) {
            if (tc.type !== "function") continue;
            const toolInput = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            // Guardrail 6: gate submit_code_change on prior successful read (OR loop)
            let callResult: { ok: boolean; result?: unknown; error?: string };
            if (tc.function.name === "submit_code_change") {
              const input = toolInput as { files?: Array<{ path: string }> };
              const targetPaths = (input.files ?? []).map((f) => f.path);
              const unread = targetPaths.filter((p) => !orReadPaths.has(p));
              if (unread.length > 0) {
                callResult = {
                  ok: false,
                  error:
                    `Refusing to submit_code_change: file(s) not previously read with read_github_file: ${unread.join(", ")}. ` +
                    `Call read_github_file({ path: "<that path>" }) first. If the read returns "not found", DO NOT submit a placeholder — instead return a plain text response explaining the file does not exist.`,
                };
              } else {
                callResult = await executeTool(this.env.DB, { searxngBaseUrl: this.env.SEARXNG_BASE_URL, braveApiKey: this.env.BRAVE_SEARCH_API_KEY }, tc.function.name, toolInput);
              }
            } else {
              callResult = await executeTool(this.env.DB, { searxngBaseUrl: this.env.SEARXNG_BASE_URL, braveApiKey: this.env.BRAVE_SEARCH_API_KEY }, tc.function.name, toolInput);
              if (tc.function.name === "read_github_file" && callResult.ok) {
                // Guardrail 6 (Bug 2 fix, Apr 2026): /api/build/read-file returns
                // ok:true with `exists:false` on 404 — do NOT add to readPaths,
                // otherwise the model can submit fabricated content for a path
                // that doesn't actually exist on the branch.
                const r = (callResult.result ?? callResult) as { exists?: boolean; status?: number; error?: unknown; notFound?: boolean };
                const fileMissing = r?.exists === false || r?.notFound === true || r?.status === 404 || typeof r?.error === "string";
                if (!fileMissing) {
                  const path = (toolInput as { path?: string })?.path;
                  if (typeof path === "string") orReadPaths.add(path);
                }
              }
            }
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: callResult.ok ? JSON.stringify(callResult.result) : `Error: ${callResult.error}`,
            });
            this.broadcast(JSON.stringify({ type: "tool_call", toolName: tc.function.name, ok: callResult.ok }));
            await this.emitEvent(taskId, "tool.called", {
              tool: tc.function.name,
              ok: callResult.ok,
              provider: "openrouter",
              model: modelConfig.model,
              args: toolInput,
              error: callResult.ok ? undefined : callResult.error,
              resultPreview: callResult.ok ? JSON.stringify(callResult.result).slice(0, 500) : undefined,
            }, new Date().toISOString());
          }
          continue;
        }

        finalText = msg?.content ?? "";
        break;
      }
    } else {
      // Anthropic fallback
      const anthropic = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
      const anthropicTools = this.buildAnthropicTools(allToolRows);
      const anthropicMessages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];

      // ── Guardrail 5: Loop iteration cap (Anthropic fallback) ────────────────
      // For code_change: keep forcing tool use until submit_code_change has run.
      // After read_github_file, the model tends to drift into narrative text
      // ("I'll generate the file and submit it") and never call submit_code_change.
      let submitCodeChangeCalled = false;
      let readGithubFileCalled = false;
      // ── Guardrail 6: Submit-without-read protection ─────────────────────────
      // Track which paths were successfully fetched via read_github_file. The
      // submit_code_change tool MUST NOT write to a path we never read — that
      // would let the model fabricate file contents (e.g. when GitHub returns
      // 404 the model hallucinated a 3-line placeholder and submitted it).
      const readPaths = new Set<string>();
      while (iterations < MAX_LOOP_ITERATIONS) {
        iterations++;
        const isCodeKind =
          task.kind === "code_change" || task.kind === "config_change" || task.kind === "intel_review";
        // Force tool use on iter 1 always; for code_change, keep forcing until
        // submit_code_change has been called (so the agent can't bail out with
        // descriptive text after read_github_file).
        const forceToolUse =
          anthropicTools.length > 0 &&
          isCodeKind &&
          (iterations === 1 || (task.kind === "code_change" && !submitCodeChangeCalled));
        // After read_github_file has run at least once for a code_change, pin the
        // next call to submit_code_change specifically — otherwise the model loops
        // re-reading the same file because tool_choice:"any" lets it pick anything.
        const hasSubmitTool = anthropicTools.some((t) => t.name === "submit_code_change");
        const pinSubmit =
          task.kind === "code_change" &&
          readGithubFileCalled &&
          !submitCodeChangeCalled &&
          hasSubmitTool;
        const toolChoice = pinSubmit
          ? ({ type: "tool" as const, name: "submit_code_change" })
          : forceToolUse
            ? ({ type: "any" as const })
            : undefined;
        const response = await anthropic.messages.create({
          model: "claude-haiku-4-5",
          max_tokens: modelConfig.maxTokens,
          system: systemPrompt,
          tools: anthropicTools.length > 0 ? anthropicTools : undefined,
          ...(toolChoice ? { tool_choice: toolChoice } : {}),
          messages: anthropicMessages,
        });
        totalPromptTokens += response.usage.input_tokens;
        totalCompletionTokens += response.usage.output_tokens;
        // Anthropic echoes the served model id. Bug 3 fix (Apr 2026).
        if (response.model) actualModel = response.model;

        if (response.stop_reason === "end_turn") {
          const block = response.content.find((b) => b.type === "text");
          finalText = block?.type === "text" ? block.text : "";
          break;
        }

        if (response.stop_reason === "tool_use") {
          anthropicMessages.push({ role: "assistant", content: response.content });
          const toolResults: Anthropic.ToolResultBlockParam[] = [];
          for (const block of response.content) {
            if (block.type !== "tool_use") continue;

            // ── Guardrail 6: gate submit_code_change on prior successful read ──
            // Reject any submit whose target paths weren't fetched in this task.
            // Fail loud with a structured error so the model can self-correct.
            let callResult: { ok: boolean; result?: unknown; error?: string };
            if (block.name === "submit_code_change") {
              const input = block.input as { files?: Array<{ path: string }> };
              const targetPaths = (input.files ?? []).map((f) => f.path);
              const unread = targetPaths.filter((p) => !readPaths.has(p));
              if (unread.length > 0) {
                callResult = {
                  ok: false,
                  error:
                    `Refusing to submit_code_change: file(s) not previously read with read_github_file: ${unread.join(", ")}. ` +
                    `Call read_github_file({ path: "<that path>" }) first. If the read returns "not found", DO NOT submit a placeholder — instead return a plain text response explaining the file does not exist.`,
                };
              } else {
                callResult = await executeTool(
                  this.env.DB, { searxngBaseUrl: this.env.SEARXNG_BASE_URL, braveApiKey: this.env.BRAVE_SEARCH_API_KEY },
                  block.name, block.input as Record<string, unknown>,
                );
                if (callResult.ok) submitCodeChangeCalled = true;
              }
            } else {
              callResult = await executeTool(
                this.env.DB, { searxngBaseUrl: this.env.SEARXNG_BASE_URL, braveApiKey: this.env.BRAVE_SEARCH_API_KEY },
                block.name, block.input as Record<string, unknown>,
              );
              if (block.name === "read_github_file" && callResult.ok) {
                readGithubFileCalled = true;
                // Guardrail 6 (Bug 2 fix, Apr 2026): exists:false / 404 must NOT
                // count as a successful read — otherwise the model fabricates a
                // file body and submit_code_change accepts it.
                const r = (callResult.result ?? callResult) as { exists?: boolean; status?: number; error?: unknown; notFound?: boolean };
                const fileMissing = r?.exists === false || r?.notFound === true || r?.status === 404 || typeof r?.error === "string";
                if (!fileMissing) {
                  const path = (block.input as { path?: string })?.path;
                  if (typeof path === "string") readPaths.add(path);
                }
              }
            }
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: callResult.ok ? JSON.stringify(callResult.result) : `Error: ${callResult.error}`,
            });
            this.broadcast(JSON.stringify({ type: "tool_call", toolName: block.name, ok: callResult.ok }));
            await this.emitEvent(taskId, "tool.called", {
              tool: block.name,
              ok: callResult.ok,
              provider: "anthropic",
              model: "claude-haiku-4-5",
              args: block.input,
              error: callResult.ok ? undefined : callResult.error,
              resultPreview: callResult.ok ? JSON.stringify(callResult.result).slice(0, 500) : undefined,
            }, new Date().toISOString());
          }
          anthropicMessages.push({ role: "user", content: toolResults });
          continue;
        }

        const block = response.content.find((b) => b.type === "text");
        finalText = block?.type === "text" ? block.text : "";
        break;
      }
    }

    // ── Swarm handoff detection ──────────────────────────────────────────────
    // If agent output contains <HANDOFF to="agent-id">context</HANDOFF>,
    // create a new peer task assigned to the target agent and mark this one done.
    const handoffMatch = finalText.match(/<HANDOFF\s+to="([^"]+)">([\s\S]*?)<\/HANDOFF>/i);
    if (handoffMatch) {
      const targetAgentId = (handoffMatch[1] ?? "").trim();
      const handoffCtx    = (handoffMatch[2] ?? "").trim();
      if (targetAgentId) {
        await this.executeSwarmHandoff(task, targetAgentId, handoffCtx);
        // Replace the HANDOFF tag with a clean note in the final output
        finalText = finalText.replace(/<HANDOFF[\s\S]*?<\/HANDOFF>/gi,
          `\n\n🔀 Handing off to ${targetAgentId}…`).trim();
      }
    }

    return { text: finalText, promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens, provider: useOpenRouter ? "openrouter" : "anthropic", actualModel };
  }

  // ── Swarm handoff ────────────────────────────────────────────────────────────
  // OpenAI Swarm pattern: an agent explicitly passes control to a named peer.
  // Creates a child task with handoff_from set, preserving the conversation chain.

  private async executeSwarmHandoff(
    sourceTask: TaskRow,
    targetAgentId: string,
    context: string,
  ): Promise<void> {
    const now = new Date().toISOString();
    const newTaskId = crypto.randomUUID();

    // Look up the target agent's team
    const targetAgent = await queryOne<{ id: string; team_id?: string }>(
      this.env.DB,
      "SELECT id FROM agents WHERE id = ? LIMIT 1",
      [targetAgentId],
    );
    if (!targetAgent) {
      console.warn(`[Swarm] Handoff target ${targetAgentId} not found — skipping`);
      return;
    }

    // Inherit team from task or derive from agent ID prefix
    const teamId = sourceTask.assigned_agent_id?.replace("agent-", "team-").replace(/-lead$/, "")
      ?? "team-research";

    await run(this.env.DB,
      `INSERT INTO tasks (id, kind, status, assigned_agent_id, team_id, input,
        parent_task_id, spawn_depth, telegram_chat_id, telegram_message_id,
        handoff_from, handoff_context, created_at, updated_at)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newTaskId,
        sourceTask.kind,
        targetAgentId,
        teamId,
        JSON.stringify({ summary: context || `Handoff from ${sourceTask.assigned_agent_id}`, details: "" }),
        sourceTask.id,
        (sourceTask.spawn_depth ?? 0) + 1,
        sourceTask.telegram_chat_id,
        null,               // new message will be sent on progress
        sourceTask.assigned_agent_id,
        context.slice(0, 500),
        now, now,
      ],
    );

    // Update source task with handoff_to so chain is traceable
    await run(this.env.DB,
      "UPDATE tasks SET handoff_to=?, updated_at=? WHERE id=?",
      [targetAgentId, now, sourceTask.id],
    );

    // Swarm handoffs are internal — suppress from user-facing Telegram to reduce noise.
    // The final result task sends its own completion message.
    console.log(`[Swarm] Handoff notified internally: ${sourceTask.assigned_agent_id} → ${targetAgentId}`);

    console.log(`[Swarm] Handoff ${sourceTask.id} → ${targetAgentId} (new task ${newTaskId})`);
  }

  // ── Telegram progress / completion helpers ──────────────────────────────────

  private async editTelegramProgress(
    task: TaskRow,
    nodesCompleted: number,
    totalNodes: number,
    elapsedSeconds: number,
    etaSeconds: number,
    currentStep: string,
  ): Promise<void> {
    if (!task.telegram_chat_id) return;
    if (!this.env.TELEGRAM_BOT_TOKEN) return;

    const remaining = Math.max(0, etaSeconds - elapsedSeconds);
    const bar = tgProgressBar(nodesCompleted, totalNodes);
    const pct = totalNodes > 0 ? Math.round((nodesCompleted / totalNodes) * 100) : 0;

    // Pull task label from input
    let taskLabel = task.kind;
    try {
      const inp = JSON.parse(task.input) as { summary?: string };
      if (inp.summary) taskLabel = inp.summary;
    } catch { /* ignore */ }

    const text =
      `🔄 <b>${taskLabel}</b>\n` +
      `${bar} ${pct}%\n` +
      `${currentStep}\n` +
      `⏱ ${elapsedSeconds}s · ~${remaining}s remaining`;

    if (task.telegram_message_id) {
      // Edit existing progress stub
      await this.tgEdit(task.telegram_chat_id, task.telegram_message_id, text);
    } else if (nodesCompleted === 0) {
      // First call for a cron task (no prior message) — send a new stub and store the ID
      try {
        const res = await fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: task.telegram_chat_id, text, parse_mode: "HTML" }),
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) {
          const data = await res.json<{ result?: { message_id?: number } }>();
          const msgId = data?.result?.message_id;
          if (msgId) {
            // Persist message_id so subsequent edits work
            task.telegram_message_id = msgId;
            await run(
              this.env.DB,
              "UPDATE tasks SET telegram_message_id=? WHERE id=?",
              [msgId, task.id],
            );
          }
        }
      } catch { /* non-critical */ }
    }
  }

  private async editTelegramCompletion(
    task: TaskRow,
    elapsedSeconds: number,
    rawOutput: string,
  ): Promise<void> {
    if (!task.telegram_chat_id) return;
    if (!this.env.TELEGRAM_BOT_TOKEN) return;

    // ── Parse output: handle legacy JSON format or plain markdown ────────────
    let body = rawOutput.trim();

    // If the agent returned JSON (legacy format), extract the readable parts
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (typeof parsed === "object" && parsed !== null) {
        const parts: string[] = [];

        // executiveSummary fields → compact block
        if (parsed.executiveSummary && typeof parsed.executiveSummary === "object") {
          const es = parsed.executiveSummary as Record<string, string>;
          if (es.status)   parts.push(`<b>Status:</b> ${es.status}`);
          if (es.priority) parts.push(`<b>Priority:</b> ${es.priority}`);
          if (es.action)   parts.push(`<b>Action:</b> ${es.action}`);
          if (es.risks && es.risks.toLowerCase() !== "none")
            parts.push(`<b>Risk:</b> ${es.risks}`);
        }

        // fullReport → main body
        if (typeof parsed.fullReport === "string" && parsed.fullReport.trim()) {
          if (parts.length > 0) parts.push("──────────────────────");
          parts.push(parsed.fullReport.trim());
        } else if (typeof parsed.response === "string" && parsed.response.trim()) {
          parts.push(parsed.response.trim());
        }

        body = parts.join("\n") || body;
      }
    } catch { /* not JSON — use as-is */ }

    // ── Escape HTML special chars in plain-text sections ─────────────────────
    // Only escape the body; our own <b> tags stay intact
    const escapeHtml = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // Convert markdown to Telegram HTML (bold **x**, headers ## x, bullets)
    const markdownToHtml = (s: string): string =>
      s
        .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/^#{1,3}\s+(.+)$/gm, "<b>$1</b>")
        .replace(/^[-•]\s+/gm, "• ")
        .replace(/\[URGENT\]/g, "🔴 <b>URGENT</b>");

    // Detect if body already has HTML tags (from our JSON extraction above)
    const hasHtmlTags = /<b>/.test(body);
    const formattedBody = hasHtmlTags
      ? markdownToHtml(body)                        // already partially HTML
      : markdownToHtml(escapeHtml(body));            // raw text — escape first

    // Pull task summary label from input
    let taskLabel = task.kind;
    try {
      const inp = JSON.parse(task.input) as { summary?: string };
      if (inp.summary) taskLabel = inp.summary;
    } catch { /* ignore */ }

    // Trim to Telegram's 4096 char limit (leave room for header/footer)
    const MAX_BODY = 3200;
    const trimmedBody = formattedBody.length > MAX_BODY
      ? formattedBody.slice(0, MAX_BODY) + "\n<i>...truncated — see /status for full output</i>"
      : formattedBody;

    // ── Edit the progress stub (if exists) ───────────────────────────────────
    if (task.telegram_message_id) {
      await this.tgEdit(
        task.telegram_chat_id,
        task.telegram_message_id,
        `✅ <b>${escapeHtml(taskLabel)}</b> done in ${elapsedSeconds}s`,
      );
    }

    // ── Extract ACTION ITEM and move it to the top ────────────────────────────
    const actionItemMatch = trimmedBody.match(/---\s*\n(ACTION[^:]*:.*?)(?:\n|$)/i)
      ?? trimmedBody.match(/(ACTION ITEM:.*?)(?:\n──|$)/is);
    const actionLine = actionItemMatch
      ? `🎯 <b>${escapeHtml((actionItemMatch[1] ?? "").replace(/^ACTION[^:]*:\s*/i, "ACTION: ").trim())}</b>\n`
      : "";
    // Strip ACTION ITEM and TRADE_ORDER block from body (both are surfaced elsewhere)
    const cleanBody = trimmedBody
      .replace(/---\s*\nACTION[^:]*:.*?(?=\n──|$)/is, "")
      .replace(/ACTION ITEM:.*?(?=\n|$)/ig, "")
      .replace(/##TRADE_ORDER##[\s\S]*?##END_TRADE_ORDER##/g, "")
      .trim();

    // ── Send the full result as a new notification ────────────────────────────
    const text =
      (actionLine ? actionLine + `──────────────────────\n` : "") +
      `✅ <b>${escapeHtml(taskLabel)}</b> · ${elapsedSeconds}s\n` +
      `──────────────────────\n` +
      `${cleanBody}\n` +
      `──────────────────────\n` +
      `<code>/status ${task.id}</code>`;

    // ── Self-learning inline keyboard ─────────────────────────────────────────
    // For intel & finance tasks, ask what caught the user's attention so the
    // agent learns which topics to prioritise in future reports.
    const agentId = task.assigned_agent_id ?? "agent-research-lead";
    let replyMarkup: object | undefined;

    if (task.kind === "intel_check" || task.kind === "intel_review" || task.assigned_agent_id === "agent-intel-lead") {
      replyMarkup = {
        inline_keyboard: [[
          { text: "🔥 Trending repos",   callback_data: `learn:${agentId}:intel_interest:trending_repos` },
          { text: "⚠️ Threats",           callback_data: `learn:${agentId}:intel_interest:security_threats` },
          { text: "💡 Opportunities",     callback_data: `learn:${agentId}:intel_interest:opportunities` },
        ], [
          { text: "📦 Open-source tools", callback_data: `learn:${agentId}:intel_interest:oss_tools` },
          { text: "🤖 AI models",          callback_data: `learn:${agentId}:intel_interest:ai_models` },
          { text: "📰 Skip for now",       callback_data: `learn:${agentId}:intel_interest:no_preference` },
        ]],
      };
    } else if (
      task.assigned_agent_id === "agent-finance-lead" ||
      /trading|finance|options|roll|credit|pnl/i.test(task.kind)
    ) {
      // ── Try to detect + stage a tradeable recommendation ───────────────────
      // PRIMARY PATH: agent emits a structured ##TRADE_ORDER## JSON block.
      // FALLBACK: regex scan for OCC symbols in plain text.
      let pendingOrderId: string | undefined;

      if (this.env.SCHWAB_CLIENT_ID) {
        try {
          // ── Primary: parse ##TRADE_ORDER## block ────────────────────────────
          const blockMatch = rawOutput.match(/##TRADE_ORDER##\s*([\s\S]*?)\s*##END_TRADE_ORDER##/);

          if (blockMatch) {
            const parsed = JSON.parse(blockMatch[1] ?? "{}") as {
              account?:     string;
              order_type?:  string;
              price?:       number;
              description?: string;
              legs?:        Array<{ instruction: string; quantity: number; symbol: string }>;
            };

            if (parsed.legs && parsed.legs.length > 0) {
              pendingOrderId = await stagePendingOrder(this.env.DB, {
                account_number: parsed.account ?? "749",
                order_type:     (parsed.order_type ?? "LIMIT") as "NET_CREDIT" | "NET_DEBIT" | "LIMIT",
                price:          parsed.price ?? 0.01,
                description:    parsed.description ?? "Trade recommendation from agent-finance-lead",
                legs:           parsed.legs.map((l) => ({
                  instruction: l.instruction as "BUY_TO_OPEN" | "BUY_TO_CLOSE" | "SELL_TO_OPEN" | "SELL_TO_CLOSE",
                  quantity:    l.quantity,
                  symbol:      l.symbol,
                  asset_type:  "OPTION" as const,
                })),
              });
            }
          } else {
            // ── Fallback: regex extraction for unstructured output ─────────────
            const hasTradeRec = /\b(BUY|SELL)_(TO_OPEN|TO_CLOSE)\b/i.test(rawOutput)
              || /\broll\b.*\b(credit|debit)\b/i.test(rawOutput);

            if (hasTradeRec) {
              const descMatch = rawOutput.match(/ACTION\s*ITEM:\s*(.+?)(?:\n|$)/i)
                || rawOutput.match(/^(.{10,120}(?:roll|credit|debit|call|put).{0,60})/im);
              const description = descMatch
                ? (descMatch[1] ?? "").replace(/<[^>]+>/g, "").trim().slice(0, 200)
                : "Trade recommendation from agent-finance-lead";

              const orderType: "NET_CREDIT" | "NET_DEBIT" | "LIMIT" =
                /net\s*credit/i.test(rawOutput) ? "NET_CREDIT"
                : /net\s*debit/i.test(rawOutput) ? "NET_DEBIT"
                : "LIMIT";

              let price = 0.01;
              const rangeMatch = rawOutput.match(/[Ll]imit[:\s]+\$?([\d.]+)\s*[-–—to]+\s*\$?([\d.]+)/);
              const singleMatch = rawOutput.match(/\$\s*([\d.]+)\s*net\s*(credit|debit)/i);
              if (rangeMatch) {
                price = (parseFloat(rangeMatch[1] ?? "0") + parseFloat(rangeMatch[2] ?? "0")) / 2;
              } else if (singleMatch) {
                price = parseFloat(singleMatch[1] ?? "0");
              }

              // OCC pattern: INSTRUCTION QTY× SYMBOL (with or without internal spaces)
              const legPattern = /\b(BUY_TO_OPEN|BUY_TO_CLOSE|SELL_TO_OPEN|SELL_TO_CLOSE)\s+(\d+)[×x]?\s*([A-Z]{1,6}\s*\d{6}[CP]\d{8})/gi;
              const legs: Array<{ instruction: string; quantity: number; symbol: string; asset_type: "OPTION" }> = [];
              let m: RegExpExecArray | null;
              while ((m = legPattern.exec(rawOutput)) !== null) {
                legs.push({
                  instruction: (m[1] ?? "BUY_TO_OPEN").toUpperCase() as "BUY_TO_OPEN" | "BUY_TO_CLOSE" | "SELL_TO_OPEN" | "SELL_TO_CLOSE",
                  quantity:    parseInt(m[2] ?? "1", 10) || 1,
                  symbol:      (m[3] ?? "").trim(),
                  asset_type:  "OPTION",
                });
              }

              if (legs.length > 0) {
                const acctNote = await queryOne<{ value: string }>(
                  this.env.DB,
                  `SELECT value FROM agent_notes WHERE agent_id='agent-finance-lead' AND key='default_account'`,
                  [],
                );
                pendingOrderId = await stagePendingOrder(this.env.DB, {
                  account_number: acctNote?.value ?? "749",
                  order_type:     orderType,
                  price,
                  legs:           legs as Parameters<typeof stagePendingOrder>[1]["legs"],
                  description,
                });
              }
            }
          }
        } catch (e) {
          console.error("[AgentActor] Failed to stage pending order:", e);
        }
      }

      // Build keyboard — add "Approve to execute" row if we staged an order
      const baseButtons = [[
        { text: "📋 View breakdown",  callback_data: `followup:${agentId}:view_breakdown:${task.id}` },
        { text: "↩ Ask a follow-up", callback_data: `followup:${agentId}:ask_followup:${task.id}` },
      ]];

      if (pendingOrderId) {
        baseButtons.push([
          { text: "✅ Approve to execute", callback_data: `execute_order:${pendingOrderId}` },
          { text: "❌ Reject trade",        callback_data: `reject_order:${pendingOrderId}` },
        ]);
      }

      replyMarkup = { inline_keyboard: baseButtons };
    }

    // ── R16: chunked send with fail-loud + plain-text fallback ───────────────
    // The body produced above is one message; if its UTF-16 length blows past
    // 4000, formatForTelegram chunks it. If any chunk fails HTML validation,
    // every chunk downgrades to plain text. Send failures are persisted to
    // the events table so silent drops surface in the supervisor digest.
    const chunks: Array<{ text: string; parseMode: "HTML" | null }> =
      text.length <= 4000
        ? [{ text, parseMode: "HTML" as const }]
        : formatForTelegram(text);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk) continue;
      const isFirst = i === 0;

      const payload: Record<string, unknown> = {
        chat_id: task.telegram_chat_id,
        text: chunk.text,
      };
      if (chunk.parseMode) payload.parse_mode = chunk.parseMode;
      if (isFirst && replyMarkup) payload.reply_markup = replyMarkup;

      const resp = await fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      }).catch((err) => {
        console.error(`[editTelegramCompletion] fetch threw for ${task.id}:`, err);
        return null;
      });

      if (resp && resp.ok) continue;

      const status = resp?.status ?? 0;
      const errBody = resp ? await resp.text().catch(() => "") : "";
      console.error(
        `[editTelegramCompletion] HTML send failed for ${task.id} chunk ${i + 1}/${chunks.length}: ${status} ${errBody.slice(0, 200)}`,
      );
      const now1 = new Date().toISOString();
      await run(
        this.env.DB,
        `INSERT INTO events (id, kind, actor_id, target_kind, target_id, payload, session_id, created_at, updated_at)
         VALUES (?, 'telegram.send_failed', ?, 'task', ?, ?, NULL, ?, ?)`,
        [
          crypto.randomUUID(),
          task.assigned_agent_id ?? null,
          task.id,
          JSON.stringify({
            chunkIndex: i,
            totalChunks: chunks.length,
            status,
            errBody: errBody.slice(0, 500),
            parseMode: chunk.parseMode,
          }),
          now1,
          now1,
        ],
      ).catch(() => { /* event log best-effort */ });

      if (chunk.parseMode !== "HTML") continue;

      // Plain-text retry — strip tags and try again with no parse_mode.
      const plain = stripHtmlToPlain(chunk.text);
      const retryPayload: Record<string, unknown> = {
        chat_id: task.telegram_chat_id,
        text: plain,
      };
      if (isFirst && replyMarkup) retryPayload.reply_markup = replyMarkup;

      const retry = await fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(retryPayload),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);

      if (retry && retry.ok) continue;

      const retryStatus = retry?.status ?? 0;
      console.error(
        `[editTelegramCompletion] plain-text retry failed for ${task.id} chunk ${i + 1}: ${retryStatus}`,
      );
      const now2 = new Date().toISOString();
      await run(
        this.env.DB,
        `INSERT INTO events (id, kind, actor_id, target_kind, target_id, payload, session_id, created_at, updated_at)
         VALUES (?, 'telegram.send_failed.retry', ?, 'task', ?, ?, NULL, ?, ?)`,
        [
          crypto.randomUUID(),
          task.assigned_agent_id ?? null,
          task.id,
          JSON.stringify({ chunkIndex: i, status: retryStatus }),
          now2,
          now2,
        ],
      ).catch(() => { /* event log best-effort */ });
    }
  }

  private async tgEdit(chatId: number, messageId: number, text: string): Promise<void> {
    try {
      await fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN!}/editMessageText`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch { /* non-critical — ignore Telegram edit failures */ }
  }

  // ── Graph LLM call (non-streaming with 55s timeout) ──────────────────────
  // Graph nodes use non-streaming to avoid hanging SSE connections.
  // Tokens are broadcast to WS clients after the full response arrives.
  // Returns text + token usage for cost tracking.

  private async streamingLlmCall(
    systemPrompt: string,
    userMessage: string,
    _tools: OpenAI.Chat.ChatCompletionTool[],   // tools unused — graph nodes are pure text
    modelConfig: { model: string; maxTokens: number; temperature: number },
  ): Promise<{ text: string; promptTokens: number; completionTokens: number }> {
    this.broadcast(JSON.stringify({ type: "stream_start" }));
    let fullText = "";
    let promptTokens = 0;
    let completionTokens = 0;

    // 110s wall-clock timeout — Kimi K2.5 first-token latency can exceed 55s on loaded nodes.
    // CPU idle time (network wait) does not count against DO's 30s CPU cap.
    const timeout = AbortSignal.timeout(110_000);

    if (this.env.OPENROUTER_API_KEY) {
      const client = new OpenAI({
        baseURL: OPENROUTER_BASE_URL,
        apiKey: this.env.OPENROUTER_API_KEY,
        defaultHeaders: {
          "HTTP-Referer": OPENROUTER_APP_URL,
          "X-Title": OPENROUTER_APP_NAME,
        },
      });

      const response = await client.chat.completions.create(
        {
          model: modelConfig.model,
          max_tokens: modelConfig.maxTokens,
          temperature: modelConfig.temperature,
          stream: false,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
        },
        { signal: timeout },
      );

      fullText = response.choices[0]?.message?.content ?? "";
      promptTokens = response.usage?.prompt_tokens ?? 0;
      completionTokens = response.usage?.completion_tokens ?? 0;
    } else {
      // Anthropic fallback
      const anthropic = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: modelConfig.maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      });
      const block = response.content.find((b) => b.type === "text");
      fullText = block?.type === "text" ? block.text : "";
      promptTokens = response.usage.input_tokens;
      completionTokens = response.usage.output_tokens;
    }

    // Broadcast full text as a single token event for WS clients
    if (fullText) this.broadcast(JSON.stringify({ type: "token", text: fullText }));
    this.broadcast(JSON.stringify({ type: "stream_end", promptTokens, completionTokens }));
    return { text: fullText, promptTokens, completionTokens };
  }

  // ── Spawn sub-tasks ─────────────────────────────────────────────────────────

  private async handleSpawn(
    spawnJson: string,
    taskId: string,
    agentId: string,
    now: string,
    currentDepth: number,
  ): Promise<boolean> {
    try {
      const rawList = JSON.parse(spawnJson) as Array<{ kind: string; summary: string; details?: string }>;

      // ── Guardrail 2 & 3: Spawn depth + count limit ────────────────────────
      const guard = guardSpawn(rawList, currentDepth);
      if (!guard.allowed) {
        console.warn(`[Guardrail] Spawn blocked for task ${taskId}: ${guard.reason}`);
        await this.emitEvent(taskId, "guardrail.spawn_blocked",
          makeGuardrailEvent("spawn_depth", guard.reason ?? "depth limit", taskId), now);
        return false;
      }
      const spawnList = guard.clampedList ?? rawList;
      if (guard.reason) {
        console.warn(`[Guardrail] ${guard.reason} for task ${taskId}`);
        await this.emitEvent(taskId, "guardrail.spawn_clamped",
          makeGuardrailEvent("spawn_count", guard.reason, taskId), now);
      }

      const childIds: string[] = [];
      const childDepth = currentDepth + 1;

      for (const spawn of spawnList) {
        // Sanitise spawned task summary before storing
        const { safe: safeSummary } = sanitiseInput(spawn.summary);
        const childId = crypto.randomUUID();
        await run(
          this.env.DB,
          `INSERT INTO tasks (id, kind, status, parent_task_id, assigned_agent_id, input, spawn_depth, created_at, updated_at)
           VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
          [childId, spawn.kind, taskId, agentId,
           JSON.stringify({ summary: safeSummary, details: spawn.details ?? "" }),
           childDepth, now, now],
        );
        childIds.push(childId);
      }

      const waitingOutput = JSON.stringify({ pendingChildren: childIds, spawnedAt: now });
      await run(
        this.env.DB,
        "UPDATE tasks SET status='waiting_children', output=?, updated_at=? WHERE id=?",
        [waitingOutput, now, taskId],
      );
      await this.emitEvent(taskId, "session.node_completed", {
        note: `spawned ${childIds.length} sub-tasks`, childIds,
      }, now);
      this.broadcast(JSON.stringify({ type: "spawned", childIds }));
      return true;
    } catch {
      return false;
    }
  }

  // ── Agent-to-agent messaging ─────────────────────────────────────────────────

  async sendToAgent(targetAgentId: string, taskId: string, sessionId: string): Promise<void> {
    const doId = this.env.AGENT_ACTOR.idFromName(targetAgentId);
    const stub = this.env.AGENT_ACTOR.get(doId);
    await stub.fetch("https://do/enqueue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, sessionId }),
    });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private broadcast(data: string): void {
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(data); } catch { /* client disconnected */ }
    }
  }

  // ── Live market data — Schwab primary, Yahoo Finance fallback ────────────────
  // Finance tasks get real quotes from Schwab (authenticated). Yahoo is the
  // fallback when Schwab isn't authorized or credentials aren't set.
  private async fetchMarketContext(): Promise<string> {
    const CORE_SYMBOLS = ["SPY", "QQQ", "GOOGL", "TSLA", "NVDA", "ORCL", "VIX"];

    // ── Try Schwab first ────────────────────────────────────────────────────
    const clientId     = this.env.SCHWAB_CLIENT_ID;
    const clientSecret = this.env.SCHWAB_CLIENT_SECRET;

    if (clientId && clientSecret) {
      try {
        // Force-sync positions from Schwab before reading — closes 4/27 stale-cache incident
        // where bot answered HOLD on a position that had already been closed in TOS.
        try {
          await syncPositions(this.env.DB, clientId, clientSecret);
        } catch {
          // Schwab API hiccup → fall through to whatever's cached
        }
        // Merge held symbols with core watchlist
        const { positions } = await getStoredPositions(this.env.DB);
        const heldSymbols   = positions.map((p) => p.symbol).filter((s) => s !== "VIX");
        const allSymbols    = [...new Set([...CORE_SYMBOLS, ...heldSymbols])];

        const quotes = await fetchQuotes(this.env.DB, clientId, clientSecret, allSymbols);
        if (quotes.length > 0) {
          const lines = quotes.map((q) => {
            const chg = `${q.change_pct >= 0 ? "+" : ""}${q.change_pct.toFixed(2)}%`;
            const vol = q.volume > 0 ? ` | Vol: ${(q.volume / 1_000_000).toFixed(1)}M` : "";
            return `${q.symbol}: $${q.last_price.toFixed(2)} ${chg}${vol}`;
          });
          return `[Schwab Live Quotes]\n${lines.join("\n")}`;
        }
      } catch {
        // Fall through to Yahoo Finance
      }
    }

    // ── Yahoo Finance fallback ───────────────────────────────────────────────
    try {
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${CORE_SYMBOLS.join(",")}&fields=regularMarketPrice,regularMarketChangePercent,preMarketPrice,preMarketChangePercent,regularMarketVolume`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; bot-nation/1.0)", "Accept": "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return `[Market data error: HTTP ${res.status}]`;

      const data = await res.json<{
        quoteResponse?: {
          result?: Array<{
            symbol: string;
            regularMarketPrice?: number;
            regularMarketChangePercent?: number;
            preMarketPrice?: number;
            preMarketChangePercent?: number;
            regularMarketVolume?: number;
          }>;
        };
      }>();

      const quotes = data.quoteResponse?.result ?? [];
      if (quotes.length === 0) return "[Yahoo Finance: no data returned]";

      const lines = quotes.map((q) => {
        const price = q.regularMarketPrice?.toFixed(2) ?? "N/A";
        const chg   = q.regularMarketChangePercent != null
          ? `${q.regularMarketChangePercent >= 0 ? "+" : ""}${q.regularMarketChangePercent.toFixed(2)}%` : "";
        const pre   = q.preMarketPrice != null
          ? ` | Pre: $${q.preMarketPrice.toFixed(2)}` : "";
        const vol   = q.regularMarketVolume != null
          ? ` | Vol: ${(q.regularMarketVolume / 1_000_000).toFixed(1)}M` : "";
        return `${q.symbol}: $${price} ${chg}${pre}${vol}`;
      });
      return `[Yahoo Finance]\n${lines.join("\n")}`;
    } catch (err) {
      return `[Market data fetch failed: ${err instanceof Error ? err.message : String(err)}]`;
    }
  }

  // ── Self-critique — Microsoft ai-agents-for-beginners pattern ───────────────
  // One Gemini Flash call reviews the agent's output before it reaches Telegram.
  // If score < 4 on any dimension, returns the rewritten version; else null.
  private async selfCritique(originalText: string, taskKind: string): Promise<string | null> {
    if (!this.env.OPENROUTER_API_KEY) return null;

    const client = new OpenAI({
      baseURL: OPENROUTER_BASE_URL,
      apiKey: this.env.OPENROUTER_API_KEY!,
      defaultHeaders: {
        "HTTP-Referer": OPENROUTER_APP_URL,
        "X-Title":      OPENROUTER_APP_NAME,
      },
    });

    const response = await client.chat.completions.create({
      model:       MODELS.GEMINI_FLASH,   // cheap + fast: ~$0.001 per call
      max_tokens:  1500,
      temperature: 0.1,
      messages: [{
        role:    "user",
        content: `You are a quality reviewer for an AI agent output. Review the ${taskKind} response below and rate it on:
1. Completeness (1–5): Does it fully address what was asked?
2. Accuracy (1–5): Are all stated facts credible and consistent?
3. Actionability (1–5): Does it give the operator something concrete to act on?

If ALL scores are 4 or higher: respond with exactly the word PASS.
If ANY score is below 4: respond with REWRITE: followed immediately by an improved version that fixes the weakness. No preamble — just REWRITE: and the improved text.

RESPONSE TO REVIEW:
${originalText.slice(0, 2500)}`,
      }],
      signal: AbortSignal.timeout(25_000),
    });

    const decision = (response.choices[0]?.message?.content ?? "").trim();
    if (!decision || decision.startsWith("PASS")) return null;
    if (decision.startsWith("REWRITE:")) {
      return decision.slice("REWRITE:".length).trim();
    }
    return null;
  }

  private buildSystemPrompt(agent: AgentRow, notesText: string, memoriesText = ""): string {
    return [
      // ── crewAI-style agent identity ─────────────────────────────────────────
      `You are ${agent.name}.`,
      `ROLE: ${agent.role} — ${agent.domain} domain`,
      agent.objectives
        ? `GOAL: ${agent.objectives}`
        : null,
      agent.description
        ? `BACKSTORY: ${agent.description}`
        : null,
      "",
      // ── Long-term memory (MemPalace layer) ──────────────────────────────────
      memoriesText || null,
      memoriesText ? "" : null,
      "FORMAT RULES — follow these exactly:",
      "- Respond in clean, readable markdown. NO raw JSON. NO code fences around your answer.",
      "- Start with a bold header: **[Task Name] — [one-sentence verdict/status]**",
      "- Use ##, ###, bullet points (•), and **bold** for structure.",
      "- Use plain numbers and symbols, NOT unicode emojis in headers.",
      "- Keep your total response under 3000 characters. Be dense, not verbose.",
      "- ALWAYS start your response with 'ACTION ITEM: [specific trade or decision]' on the very first line, then a blank line, then your analysis.",
      "- NEVER output HTML tags of any kind (<sp>, <span>, <br>, <div>, etc). Use blank lines for spacing.",
      "- NEVER include API tokens, access tokens, secrets, or credential values in your output.",
      "- For options trade recommendations: always state 'Type: [CALL rolling into CALL/PUT] or [PUT rolling into CALL/PUT] for [credit/debit]' on one line.",
      "- For limit prices: always provide a $0.10 range (e.g. 'Limit: $1.20 – $1.30 net credit'). Never recommend market orders.",
      "- For credit rolls on losing positions: min $6 credit; also show $10 debit and $40 debit alternatives (same expiry or weeks out).",
      "- Weekly focus: recommend ONE day trade and ONE weekly credit trade. No more.",
      "- TRADE EXECUTION BLOCK — required at the end of EVERY options trade recommendation:",
      "  Append this exact block so the system can auto-stage the order for one-tap execution:",
      "  ##TRADE_ORDER##",
      "  {",
      "    \"account\": \"749\",",
      "    \"order_type\": \"NET_CREDIT\",",
      "    \"price\": 0.87,",
      "    \"description\": \"Roll GOOGL 340C → 355C Apr27 for $0.87 net credit\",",
      "    \"legs\": [",
      "      { \"instruction\": \"BUY_TO_CLOSE\",  \"quantity\": 1, \"symbol\": \"GOOGL  260427C00340000\" },",
      "      { \"instruction\": \"SELL_TO_OPEN\", \"quantity\": 1, \"symbol\": \"GOOGL  260427C00355000\" }",
      "    ]",
      "  }",
      "  ##END_TRADE_ORDER##",
      "  Rules for this block:",
      "  • order_type: NET_CREDIT (you collect premium) | NET_DEBIT (you pay) | LIMIT (single-leg)",
      "  • price: the midpoint of your recommended limit range as a positive decimal (e.g. 0.87 for $0.87 credit)",
      "  • account: last 4 digits of account (use 749 for Individual, 105 for Roth IRA, 266 for Joint Tenant)",
      "  • symbol: OCC format — underlying padded to 6 chars + YYMMDD + C/P + 8-digit strike (e.g. GOOGL  260427C00340000)",
      "  • instruction: BUY_TO_OPEN | BUY_TO_CLOSE | SELL_TO_OPEN | SELL_TO_CLOSE",
      "  • Include ALL legs of the spread. For a roll: BUY_TO_CLOSE the current short + SELL_TO_OPEN the new short.",
      "  • If you are NOT recommending an actionable trade (analysis only), omit the ##TRADE_ORDER## block entirely.",
      "- Keep agent coordination details OUT of result messages — results only, no 'routing to X' or 'handoff to Y' commentary.",
      "",
      // ── Chain-of-thought scaffolding for finance domain (Lordog/dive-into-llms pattern) ──
      // Structured reasoning traces catch errors like recommending a roll on an expired contract.
      agent.domain === "execution_finance" ? "CHAIN-OF-THOUGHT (finance domain — required for trade decisions):" : null,
      agent.domain === "execution_finance" ? "For every options decision, show this exact trace on its own line before the recommendation:" : null,
      agent.domain === "execution_finance" ? "  CoT: Position=[symbol/strike/expiry] → Mark=[current] vs Entry=[entry] → P&L=[%] → DTE=[N] → Rule=[stop/target/hold/expiry] → Decision=[CLOSE/ROLL/HOLD]" : null,
      agent.domain === "execution_finance" ? "Example: CoT: GOOGL 340C Apr27 → Mark=$1.10 vs Entry=$0.60 → P&L=+83% → DTE=4 → Rule=hold(target=180%) → Decision=HOLD" : null,
      agent.domain === "execution_finance" ? "This trace is mandatory — it makes your reasoning auditable and catches stale data errors." : null,
      agent.domain === "execution_finance" ? "" : null,
      "CONTENT RULES:",
      "- Give the direct answer FIRST. Never open with disclaimers or 'I cannot...'.",
      "- If real-time data is unavailable, state the best available estimate + source.",
      "- Flag URGENT items with [URGENT] prefix.",
      "- 'petition' in a finance context means 'position' (speech-to-text artifact) — handle accordingly.",
      "- To spawn parallel sub-tasks: <SPAWN_TASKS>[{\"kind\":\"research\",\"summary\":\"...\"}]</SPAWN_TASKS>",
      "- To hand off entirely to a peer agent (Swarm protocol): <HANDOFF to=\"agent-id\">context for them</HANDOFF>",
      "  Valid handoff targets: agent-finance-lead | agent-research-lead | agent-intel-lead | agent-build-lead | agent-growth-lead | agent-infra-lead | agent-bailey-lead | agent-agency-growthops | agent-p87-planner",
      "  Use HANDOFF when the task is OUTSIDE your domain. Use SPAWN_TASKS when you need help but stay in control.",
      "",
      "INTROSPECTION TOOL — query_db:",
      "- Use the query_db tool to read live system state instead of guessing.",
      "- Call it with: { \"view\": \"<view_name>\", \"agent_id\": \"<your-agent-id>\" }",
      "- Available views: my_tasks | my_notes | system_health | active_crons | pending_proposals | agents | recent_failures | my_cost_today | skill_library | skill_detail | skill_refinements",
      "- skill_library → top 30 skills ranked by quality score (use for refinement sessions)",
      "- skill_detail  → full procedure text for one skill (pass { view: 'skill_detail', skill_id: '<id>' })",
      "- skill_refinements → recent refinement history across all skills",
      "- ALWAYS use query_db before answering questions about tasks, agents, or system status.",
      "- Never fabricate task IDs, counts, or agent states — query_db gives you the real data.",
      "",
      `Your agent ID: ${agent.id}`,
      "Your memory (agent_notes):",
      notesText,
    ].filter((line) => line !== null).join("\n").trim();
  }

  private buildOpenAITools(toolRows: ToolRow[]): OpenAI.Chat.ChatCompletionTool[] {
    return toolRows.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description ?? t.name,
        parameters: (t.schema
          ? JSON.parse(t.schema)
          : { type: "object", properties: {} }) as Record<string, unknown>,
      },
    }));
  }

  private buildAnthropicTools(toolRows: ToolRow[]): Anthropic.Tool[] {
    return toolRows.map((t) => ({
      name: t.name,
      description: t.description ?? t.name,
      input_schema: (t.schema
        ? JSON.parse(t.schema)
        : { type: "object", properties: {} }) as Anthropic.Tool["input_schema"],
    }));
  }

  private async updateSession(sessionId: string, status: string, now: string): Promise<void> {
    const completed = status === "completed" || status === "failed" ? now : null;
    await run(
      this.env.DB,
      "UPDATE agent_sessions SET status=?, updated_at=?, completed_at=COALESCE(?,completed_at) WHERE id=?",
      [status, now, completed, sessionId],
    );
  }

  private async emitEvent(
    taskId: string,
    kind: string,
    payload: Record<string, unknown>,
    now: string,
  ): Promise<void> {
    const id = crypto.randomUUID();
    await run(
      this.env.DB,
      `INSERT INTO events (id, kind, actor_id, target_kind, target_id, payload, session_id, created_at, updated_at)
       VALUES (?, ?, NULL, 'task', ?, ?, NULL, ?, ?)`,
      [id, kind, taskId, JSON.stringify(payload), now, now],
    );
  }

  /**
   * A.6+: read a boolean feature flag from agent_notes.feature_flags_json.
   * Default false when the note or the key is absent (per Config Source Precedence).
   * The flag is a property of the agent_notes row keyed on agent_id with
   * key='feature_flags_json' and value=JSON object of boolean flags.
   */
  private async readFeatureFlag(agentId: string, flagName: string): Promise<boolean> {
    try {
      const row = await queryOne<{ value: string }>(
        this.env.DB,
        "SELECT value FROM agent_notes WHERE agent_id = ? AND key = 'feature_flags_json' LIMIT 1",
        [agentId],
      );
      if (!row?.value) return false;
      const flags = JSON.parse(row.value) as Record<string, unknown>;
      return flags[flagName] === true;
    } catch {
      return false;
    }
  }
}