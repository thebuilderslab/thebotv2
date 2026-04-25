import { useState, useRef, useEffect } from "react";
import { actors, tasks } from "../api/client";

const BASE_WS = (import.meta.env["VITE_API_URL"] ?? "https://bot-nation-api.thejamalshackleford.workers.dev")
  .replace(/^https/, "wss")
  .replace(/^http/, "ws");

type StreamMsg =
  | { type: "session_started"; taskId: string; sessionId: string }
  | { type: "node_start"; nodeId: string; label: string }
  | { type: "stream_start" }
  | { type: "token"; text: string }
  | { type: "stream_end" }
  | { type: "tool_call"; toolName: string; ok: boolean }
  | { type: "tool_result"; toolName: string; ok: boolean }
  | { type: "spawned"; childIds: string[] }
  | { type: "completed"; taskId: string; summary: string }
  | { type: "error"; message: string }
  | { type: "pong" };

interface LogEntry {
  ts: string;
  type: string;
  text: string;
  color?: string;
}

export function AgentStream() {
  const [agentId, setAgentId] = useState("agent-research-lead");
  const [taskSummary, setTaskSummary] = useState("");
  const [connected, setConnected] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [tokens, setTokens] = useState("");
  const [status, setStatus] = useState<string>("idle");
  const wsRef = useRef<WebSocket | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log, tokens]);

  const addLog = (type: string, text: string, color?: string) => {
    setLog((prev) => [...prev, { ts: new Date().toISOString().slice(11, 19), type, text, color }]);
  };

  const connect = () => {
    if (wsRef.current) wsRef.current.close();
    const url = `${BASE_WS}/api/actors/${agentId}/connect`;
    const ws = new WebSocket(url);

    ws.onopen = () => {
      setConnected(true);
      setStatus("connected");
      addLog("system", `Connected to ${agentId}`, "var(--accent)");
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string) as StreamMsg;
        switch (msg.type) {
          case "session_started":
            addLog("session", `Session started: ${msg.sessionId.slice(0, 8)}…`, "var(--accent)");
            setStatus("running");
            setTokens("");
            break;
          case "node_start":
            addLog("graph", `▶ Node: ${msg.label}`, "var(--yellow)");
            break;
          case "stream_start":
            addLog("stream", "Streaming…", "var(--text-muted)");
            break;
          case "token":
            setTokens((t) => t + msg.text);
            break;
          case "stream_end":
            addLog("stream", "Stream complete", "var(--text-muted)");
            break;
          case "tool_call":
          case "tool_result":
            addLog("tool", `🔧 ${msg.toolName} → ${msg.ok ? "✓" : "✗"}`, msg.ok ? "var(--accent)" : "var(--red)");
            break;
          case "spawned":
            addLog("spawn", `⎇ Spawned ${msg.childIds.length} sub-tasks`, "var(--yellow)");
            break;
          case "completed":
            setStatus("completed");
            addLog("done", `✓ Completed: ${msg.summary.slice(0, 80)}`, "var(--accent)");
            break;
          case "error":
            setStatus("failed");
            addLog("error", `✗ ${msg.message}`, "var(--red)");
            break;
        }
      } catch { /* ignore */ }
    };

    ws.onclose = () => {
      setConnected(false);
      setStatus((s) => s === "running" ? "disconnected" : s);
      addLog("system", "Disconnected", "var(--text-muted)");
    };

    ws.onerror = () => addLog("error", "WebSocket error", "var(--red)");

    wsRef.current = ws;
  };

  const disconnect = () => {
    wsRef.current?.close();
    wsRef.current = null;
  };

  const dispatch = async () => {
    if (!taskSummary.trim()) return;
    try {
      // Create task then dispatch to DO
      const created = await tasks.create({ kind: "research", input: { summary: taskSummary } });
      addLog("dispatch", `Task ${created.id.slice(0, 8)}… created`, "var(--text-muted)");
      await actors.dispatch(agentId, created.id);
      addLog("dispatch", "Dispatched to DO", "var(--accent)");
      setTaskSummary("");
    } catch (err: unknown) {
      addLog("error", String(err), "var(--red)");
    }
  };

  const ping = () => {
    wsRef.current?.send(JSON.stringify({ type: "ping" }));
  };

  return (
    <div>
      <div className="page-title">Live Stream</div>
      <div className="page-subtitle">Real-time agent execution via Durable Objects</div>

      {/* Connection controls */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">Connection</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            placeholder="Agent ID"
            style={{
              background: "var(--bg-base)", border: "1px solid var(--border)",
              color: "var(--text-primary)", padding: "5px 10px",
              borderRadius: "var(--radius-sm)", fontSize: 12, fontFamily: "var(--font-mono)", width: 220,
            }}
          />
          {!connected ? (
            <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={connect}>
              Connect WebSocket
            </button>
          ) : (
            <>
              <button className="btn" style={{ fontSize: 12 }} onClick={disconnect}>Disconnect</button>
              <button className="btn" style={{ fontSize: 12 }} onClick={ping}>Ping</button>
            </>
          )}
          <span style={{
            fontSize: 11, padding: "3px 8px", borderRadius: "var(--radius-sm)",
            background: connected ? "var(--accent-dim)" : "var(--bg-elevated)",
            color: connected ? "var(--accent)" : "var(--text-muted)",
            border: `1px solid ${connected ? "var(--accent)" : "var(--border)"}`,
          }}>
            {status}
          </span>
        </div>
      </div>

      {/* Dispatch task */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">Dispatch Task</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            value={taskSummary}
            onChange={(e) => setTaskSummary(e.target.value)}
            placeholder="Task summary…"
            style={{
              background: "var(--bg-base)", border: "1px solid var(--border)",
              color: "var(--text-primary)", padding: "5px 10px",
              borderRadius: "var(--radius-sm)", fontSize: 12, flex: 1,
            }}
            onKeyDown={(e) => { if (e.key === "Enter") void dispatch(); }}
          />
          <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={() => void dispatch()}>
            Dispatch
          </button>
        </div>
      </div>

      {/* Stream output */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Token Stream</span>
          <button className="btn" style={{ fontSize: 10, padding: "2px 8px" }} onClick={() => setTokens("")}>Clear</button>
        </div>
        <pre style={{
          margin: 0, padding: "8px 0", fontSize: 12, color: "var(--text-primary)",
          whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-ui)",
          minHeight: 60, maxHeight: 300, overflowY: "auto",
        }}>
          {tokens || <span style={{ color: "var(--text-muted)" }}>Waiting for stream…</span>}
        </pre>
      </div>

      {/* Event log */}
      <div className="card">
        <div className="card-title" style={{ display: "flex", justifyContent: "space-between" }}>
          <span>Event Log</span>
          <button className="btn" style={{ fontSize: 10, padding: "2px 8px" }} onClick={() => setLog([])}>Clear</button>
        </div>
        <div style={{ maxHeight: 280, overflowY: "auto" }}>
          {log.length === 0 && <div className="empty">No events yet.</div>}
          {log.map((entry, i) => (
            <div key={i} style={{ display: "flex", gap: 10, padding: "2px 0", fontSize: 11 }}>
              <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", whiteSpace: "nowrap" }}>
                {entry.ts}
              </span>
              <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap", minWidth: 60 }}>
                {entry.type}
              </span>
              <span style={{ color: entry.color ?? "var(--text-secondary)" }}>{entry.text}</span>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
}
