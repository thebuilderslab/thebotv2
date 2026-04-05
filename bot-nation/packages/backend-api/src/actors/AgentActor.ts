/**
 * AgentActor — Durable Object (Phase 6)
 *
 * One persistent DO instance per agent (keyed by agent_id).
 * Responsibilities:
 *   - Maintains a task queue across invocations
 *   - Executes tasks via Claude with optional graph traversal
 *   - Streams token chunks to connected WebSocket clients
 *   - Supports agent-to-agent messaging via DO stub calls
 *   - Uses alarms for immediate dispatch + 15-min execution timeout
 */

import Anthropic from "@anthropic-ai/sdk";
import { query, queryOne, run } from "../db/schema";
import { executeTool } from "../services/tool-executor";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ActorEnv {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  BRAVE_SEARCH_API_KEY?: string;
  AGENT_ACTOR: DurableObjectNamespace;
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
}

interface AgentRow {
  id: string;
  name: string;
  role: string;
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
}

interface GraphEdge {
  from: string;
  to: string;
  condition: "always" | "on_success" | "on_failure";
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

    if (!this.isRunning) {
      await this.state.storage.setAlarm(Date.now() + 10);
    }

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
    if (this.isRunning || this.taskQueue.length === 0) return;

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
      console.error(`[AgentActor] task ${item.taskId} failed:`, msg);
      const now = new Date().toISOString();
      await run(this.env.DB, "UPDATE tasks SET status='failed', updated_at=? WHERE id=?", [now, item.taskId]);
      await this.updateSession(item.sessionId, "failed", now);
      this.broadcast(JSON.stringify({ type: "error", message: msg }));
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
      "SELECT id, kind, input, output, parent_task_id FROM tasks WHERE id = ?",
      [taskId],
    );
    if (!task) throw new Error(`Task ${taskId} not found`);

    // Load agent (derived from DO name = agent_id)
    const agentId = this.state.id.name;
    if (!agentId) throw new Error("AgentActor: DO must be keyed by agent_id (use idFromName)");
    const agent = await queryOne<AgentRow>(
      this.env.DB,
      "SELECT id, name, role, description FROM agents WHERE id = ?",
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

    if (graphRow) {
      // ── Graph traversal ────────────────────────────────────────────────────
      const graph = JSON.parse(graphRow.definition) as GraphDefinition;
      finalText = await this.traverseGraph(graph, task, agent, notesText, childResultsText, taskId, sessionId, graphRow.id);
    } else {
      // ── Flat tool-use loop (fallback — same as agent-executor.ts) ──────────
      finalText = await this.flatToolLoop(task, agent, notesText, childResultsText, taskId, sessionId);
    }

    // Check for SPAWN_TASKS
    const spawnMatch = finalText.match(/<SPAWN_TASKS>\s*([\s\S]*?)\s*<\/SPAWN_TASKS>/);
    const spawnJson = spawnMatch?.[1];
    if (spawnMatch && spawnJson) {
      const spawned = await this.handleSpawn(spawnJson, taskId, agentId, now);
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
  ): Promise<string> {
    const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
    let currentNodeId = graph.startNode;
    let prevOutput = childResultsText || [
      task.input ? (JSON.parse(task.input) as { summary?: string }).summary ?? "" : "",
    ].join("");
    let lastText = "";

    const systemPrompt = this.buildSystemPrompt(agent, notesText);
    const anthropic = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    const toolRows = await query<ToolRow>(
      this.env.DB,
      "SELECT name, description, schema FROM tools WHERE status = 'active'",
      [],
    );
    const anthropicTools = this.buildAnthropicTools(toolRows);
    const now = new Date().toISOString();

    while (currentNodeId) {
      const node = nodeMap.get(currentNodeId);
      if (!node || node.kind === "end") break;

      let nodeOutput = "";
      let nodeOk = true;

      this.broadcast(JSON.stringify({ type: "node_start", nodeId: node.id, label: node.label ?? node.id }));

      if (node.kind === "llm_call") {
        const prompt = (node.prompt ?? "Continue: {{prev}}").replace("{{prev}}", prevOutput);
        nodeOutput = await this.streamingLlmCall(anthropic, systemPrompt, prompt, anthropicTools);
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

      // Follow edge
      const edge = graph.edges.find((e) => {
        if (e.from !== currentNodeId) return false;
        if (e.condition === "always") return true;
        if (e.condition === "on_success") return nodeOk;
        if (e.condition === "on_failure") return !nodeOk;
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

    const anthropic = new Anthropic({ apiKey: this.env.ANTHROPIC_API_KEY });
    const toolRows = await query<ToolRow>(
      this.env.DB,
      "SELECT name, description, schema FROM tools WHERE status = 'active'",
      [],
    );
    const anthropicTools = this.buildAnthropicTools(toolRows);
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];
    let finalText = "";
    let iterations = 0;

    while (iterations < 10) {
      iterations++;
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        system: systemPrompt,
        tools: anthropicTools.length > 0 ? anthropicTools : undefined,
        messages,
      });

      if (response.stop_reason === "end_turn") {
        const block = response.content.find((b) => b.type === "text");
        finalText = block?.type === "text" ? block.text : "";
        break;
      }

      if (response.stop_reason === "tool_use") {
        messages.push({ role: "assistant", content: response.content });
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
        messages.push({ role: "user", content: toolResults });
        continue;
      }

      const block = response.content.find((b) => b.type === "text");
      finalText = block?.type === "text" ? block.text : "";
      break;
    }

    return finalText;
  }

  // ── Streaming LLM call (for graph nodes) ────────────────────────────────────

  private async streamingLlmCall(
    anthropic: Anthropic,
    systemPrompt: string,
    userMessage: string,
    tools: Anthropic.Tool[],
  ): Promise<string> {
    this.broadcast(JSON.stringify({ type: "stream_start" }));
    let fullText = "";

    const stream = anthropic.messages.stream({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: systemPrompt,
      tools: tools.length > 0 ? tools : undefined,
      messages: [{ role: "user", content: userMessage }],
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        const chunk = event.delta.text;
        fullText += chunk;
        this.broadcast(JSON.stringify({ type: "token", text: chunk }));
      }
    }

    this.broadcast(JSON.stringify({ type: "stream_end" }));
    return fullText;
  }

  // ── Spawn sub-tasks ─────────────────────────────────────────────────────────

  private async handleSpawn(
    spawnJson: string,
    taskId: string,
    agentId: string,
    now: string,
  ): Promise<boolean> {
    try {
      const spawnList = JSON.parse(spawnJson) as Array<{ kind: string; summary: string; details?: string }>;
      const childIds: string[] = [];

      for (const spawn of spawnList) {
        const childId = crypto.randomUUID();
        // Route via same agent (simple default) — real routing handled by cron
        await run(
          this.env.DB,
          `INSERT INTO tasks (id, kind, status, parent_task_id, assigned_agent_id, input, created_at, updated_at)
           VALUES (?, ?, 'pending', ?, ?, ?, ?, ?)`,
          [childId, spawn.kind, taskId, agentId,
           JSON.stringify({ summary: spawn.summary, details: spawn.details ?? "" }), now, now],
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
