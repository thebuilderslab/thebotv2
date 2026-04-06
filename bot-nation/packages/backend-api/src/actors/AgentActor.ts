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
import { resolveModel, OPENROUTER_BASE_URL, OPENROUTER_APP_NAME, OPENROUTER_APP_URL } from "../services/model-router";
import {
  sanitiseInput,
  guardSpawn,
  checkGraphNodeCap,
  MAX_LOOP_ITERATIONS,
  makeGuardrailEvent,
} from "../services/guardrails";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ActorEnv {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  BRAVE_SEARCH_API_KEY?: string;
  AGENT_ACTOR: DurableObjectNamespace;
  OPENROUTER_API_KEY?: string;
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
}

interface AgentRow {
  id: string;
  name: string;
  role: string;
  domain: string;
  description: string | null;
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
    // Stale-lock recovery: if alarm fires while isRunning=true, the previous task
    // timed out or the DO was killed mid-execution. Reset the lock so the next
    // queued task can proceed. The cron timeout checker handles marking the
    // stuck task as failed in D1.
    if (this.isRunning) {
      console.warn("[AgentActor] stale isRunning lock detected — resetting");
      this.isRunning = false;
      await this.state.storage.put("isRunning", false);
    }
    if (this.taskQueue.length === 0) return;

    this.isRunning = true;
    await this.state.storage.put("isRunning", true);

    const item = this.taskQueue.shift()!;
    await this.state.storage.put("taskQueue", this.taskQueue);

    // 15-minute execution timeout alarm
    await this.state.storage.setAlarm(Date.now() + 15 * 60 * 1000);

    try {
      await this.executeTask(item.taskId, item.sessionId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? (err.stack ?? "") : "";
      console.error(`[AgentActor] task ${item.taskId} FAILED: ${msg}\n${stack}`);
      const now = new Date().toISOString();
      await run(this.env.DB, "UPDATE tasks SET status='failed', updated_at=? WHERE id=?", [now, item.taskId]);
      await this.updateSession(item.sessionId, "failed", now);
      // Emit failure event so it shows up in /events and UI
      try {
        await this.emitEvent(item.taskId, "task.do_error", { error: msg, stack: stack.slice(0, 500) }, now);
      } catch { /* swallow — DB might be the cause */ }
      this.broadcast(JSON.stringify({ type: "error", taskId: item.taskId, message: msg }));
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
      "SELECT id, kind, input, output, parent_task_id, spawn_depth FROM tasks WHERE id = ?",
      [taskId],
    );
    if (!task) throw new Error(`Task ${taskId} not found`);

    // Load agent (derived from DO name = agent_id)
    const agentId = this.state.id.name;
    if (!agentId) throw new Error("AgentActor: DO must be keyed by agent_id (use idFromName)");
    const agent = await queryOne<AgentRow>(
      this.env.DB,
      "SELECT id, name, role, domain, description FROM agents WHERE id = ?",
      [agentId],
    );
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    // Load notes
    const notes = await query<NoteRow>(
      this.env.DB,
      "SELECT key, value FROM agent_notes WHERE agent_id = ?",
      [agentId],
    );
    const notesText = notes.length > 0
      ? notes.map((n) => `${n.key}: ${n.value}`).join("\n")
      : "(no stored memory)";

    // Load default graph (if any)
    const graphRow = await queryOne<GraphRow>(
      this.env.DB,
      "SELECT id, definition FROM agent_graphs WHERE agent_id = ? AND is_default = 1 LIMIT 1",
      [agentId],
    );

    // Parse task input
    let taskInput: { summary?: string; details?: string } = {};
    try { taskInput = JSON.parse(task.input) as typeof taskInput; } catch { /* ignore */ }

    // ── Guardrail 1: Input sanitisation ───────────────────────────────────────
    const summaryGuard = sanitiseInput(taskInput.summary ?? "");
    const detailsGuard = sanitiseInput(taskInput.details ?? "");
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
    await this.emitEvent(taskId, "session.started", { sessionId, agentId, graphId: graphRow?.id ?? null }, now);
    await this.updateSession(sessionId, "running", now);
    this.broadcast(JSON.stringify({ type: "session_started", taskId, sessionId }));

    let finalText = "";
    let artifactId: string | undefined;

    // Resolve model for this task
    const modelConfig = resolveModel(task.kind, agent.domain);
    this.broadcast(JSON.stringify({ type: "model_selected", model: modelConfig.model, taskKind: task.kind }));

    if (graphRow) {
      // ── Graph traversal ────────────────────────────────────────────────────
      const graph = JSON.parse(graphRow.definition) as GraphDefinition;
      finalText = await this.traverseGraph(graph, task, agent, notesText, childResultsText, taskId, sessionId, graphRow.id, modelConfig);
    } else {
      // ── Flat tool-use loop (fallback) ──────────────────────────────────────
      finalText = await this.flatToolLoop(task, agent, notesText, childResultsText, taskId, sessionId, modelConfig);
    }

    // Check for SPAWN_TASKS
    const spawnMatch = finalText.match(/<SPAWN_TASKS>\s*([\s\S]*?)\s*<\/SPAWN_TASKS>/);
    const spawnJson = spawnMatch?.[1];
    if (spawnMatch && spawnJson) {
      const spawned = await this.handleSpawn(spawnJson, taskId, agentId, now, task.spawn_depth);
      if (spawned) {
        await this.updateSession(sessionId, "completed", now);
        return;
      }
    }

    // Store artifact
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

    await this.emitEvent(taskId, "session.completed", { sessionId, artifactId }, now);
    await this.updateSession(sessionId, "completed", now);
    this.broadcast(JSON.stringify({ type: "completed", taskId, summary: finalText.slice(0, 200) }));
  }

  // ── Graph traversal ─────────────────────────────────────────────────────────

  private async traverseGraph(
    graph: GraphDefinition,
    task: TaskRow,
    agent: AgentRow,
    notesText: string,
    childResultsText: string,
    taskId: string,
    sessionId: string,
    graphId: string,
    modelConfig: { model: string; fallback: string; maxTokens: number; temperature: number },
  ): Promise<string> {
    const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
    let currentNodeId = graph.startNode;
    // Original task summary — always available for {{task}} substitution
    let taskInput: { summary?: string; details?: string } = {};
    try { taskInput = JSON.parse(task.input) as typeof taskInput; } catch { /* ignore */ }
    const taskSummary = taskInput.summary ?? task.input ?? "";
    let prevOutput = childResultsText || taskSummary;
    let lastText = "";

    const systemPrompt = this.buildSystemPrompt(agent, notesText);
    // Graph LLM nodes do NOT receive tools — tool invocation uses dedicated tool_call nodes.
    // Passing tools to streaming LLM nodes causes agentic models (Kimi, GLM) to call tools
    // mid-stream, which the streaming path cannot handle.
    const now = new Date().toISOString();
    let nodesExecuted = 0;

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
        nodeOutput = await this.streamingLlmCall(systemPrompt, prompt, [], nodeModelConfig);
        lastText = nodeOutput;
      } else if (node.kind === "tool_call" && node.toolName) {
        const toolInput: Record<string, unknown> = { query: prevOutput, message: prevOutput };
        const result = await executeTool(this.env.DB, this.env.BRAVE_SEARCH_API_KEY, node.toolName, toolInput);
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

    return lastText || prevOutput;
  }

  // ── Flat tool-use loop (no graph) ───────────────────────────────────────────

  private async flatToolLoop(
    task: TaskRow,
    agent: AgentRow,
    notesText: string,
    childResultsText: string,
    taskId: string,
    _sessionId: string,
    modelConfig: { model: string; fallback: string; maxTokens: number; temperature: number },
  ): Promise<string> {
    let taskInput: { summary?: string; details?: string } = {};
    try { taskInput = JSON.parse(task.input) as typeof taskInput; } catch { /* ignore */ }

    const systemPrompt = this.buildSystemPrompt(agent, notesText);
    const userMessage = [
      childResultsText ? `[Sub-task results]\n${childResultsText}\n\n[Task]` : "",
      taskInput.summary ?? "",
      taskInput.details ? `\n\nDetails: ${taskInput.details}` : "",
      childResultsText ? "\n\nSynthesize the sub-task results into a final structured response." : "",
    ].join("").trim();

    const toolRows = await query<ToolRow>(
      this.env.DB,
      "SELECT name, description, schema FROM tools WHERE status = 'active'",
      [],
    );
    const openaiTools = this.buildOpenAITools(toolRows);
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "user", content: userMessage },
    ];
    let finalText = "";
    let iterations = 0;

    // Use OpenRouter if key available, else fall back to Anthropic
    const useOpenRouter = !!this.env.OPENROUTER_API_KEY;

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
      while (iterations < MAX_LOOP_ITERATIONS) {
        iterations++;
        const response = await client.chat.completions.create({
          model: modelConfig.model,
          max_tokens: modelConfig.maxTokens,
          temperature: modelConfig.temperature,
          messages: [{ role: "system", content: systemPrompt }, ...messages],
          ...(openaiTools.length > 0 ? { tools: openaiTools } : {}),
        });

        const choice = response.choices[0];
        const msg = choice?.message;
        const stopReason = choice?.finish_reason;

        if (stopReason === "stop") {
          finalText = msg?.content ?? "";
          break;
        }

        if (stopReason === "tool_calls" && msg?.tool_calls?.length) {
          messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
          for (const tc of msg.tool_calls) {
            if (tc.type !== "function") continue;
            const toolInput = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            const callResult = await executeTool(this.env.DB, this.env.BRAVE_SEARCH_API_KEY, tc.function.name, toolInput);
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: callResult.ok ? JSON.stringify(callResult.result) : `Error: ${callResult.error}`,
            });
            this.broadcast(JSON.stringify({ type: "tool_call", toolName: tc.function.name, ok: callResult.ok }));
          }
          continue;
        }

        finalText = msg?.content ?? "";
        break;
      }
    } else {
      // Anthropic fallback
      const anthropic = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
      const anthropicTools = this.buildAnthropicTools(toolRows);
      const anthropicMessages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];

      // ── Guardrail 5: Loop iteration cap (Anthropic fallback) ────────────────
      while (iterations < MAX_LOOP_ITERATIONS) {
        iterations++;
        const response = await anthropic.messages.create({
          model: "claude-haiku-4-5",
          max_tokens: modelConfig.maxTokens,
          system: systemPrompt,
          tools: anthropicTools.length > 0 ? anthropicTools : undefined,
          messages: anthropicMessages,
        });

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
            const callResult = await executeTool(
              this.env.DB, this.env.BRAVE_SEARCH_API_KEY,
              block.name, block.input as Record<string, unknown>,
            );
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: callResult.ok ? JSON.stringify(callResult.result) : `Error: ${callResult.error}`,
            });
            this.broadcast(JSON.stringify({ type: "tool_call", toolName: block.name, ok: callResult.ok }));
          }
          anthropicMessages.push({ role: "user", content: toolResults });
          continue;
        }

        const block = response.content.find((b) => b.type === "text");
        finalText = block?.type === "text" ? block.text : "";
        break;
      }
    }

    return finalText;
  }

  // ── Graph LLM call (non-streaming with 25s timeout) ──────────────────────
  // Graph nodes use non-streaming to avoid hanging SSE connections.
  // Tokens are broadcast to WS clients after the full response arrives.
  // A 25-second AbortSignal prevents indefinite hangs on slow models.

  private async streamingLlmCall(
    systemPrompt: string,
    userMessage: string,
    _tools: OpenAI.Chat.ChatCompletionTool[],   // tools unused — graph nodes are pure text
    modelConfig: { model: string; maxTokens: number; temperature: number },
  ): Promise<string> {
    this.broadcast(JSON.stringify({ type: "stream_start" }));
    let fullText = "";

    const timeout = AbortSignal.timeout(55_000);

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
    }

    // Broadcast full text as a single token event for WS clients
    if (fullText) this.broadcast(JSON.stringify({ type: "token", text: fullText }));
    this.broadcast(JSON.stringify({ type: "stream_end" }));
    return fullText;
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

  private buildSystemPrompt(agent: AgentRow, notesText: string): string {
    return [
      `You are ${agent.name}, a ${agent.role} agent in Bot Nation.`,
      agent.description ?? "",
      "",
      "Your memory:",
      notesText,
      "",
      "Complete the task given to you. Be concise and specific.",
      "",
      "If you need to delegate to sub-tasks, output a SPAWN_TASKS block:",
      "<SPAWN_TASKS>[{\"kind\":\"research\",\"summary\":\"...\"}]</SPAWN_TASKS>",
    ].join("\n").trim();
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
}
