import { useEffect, useState } from "react";
import { tasks, artifacts } from "../api/client";

type Row = Record<string, unknown>;
type EventRow = Record<string, unknown>;

const STATUS_FILTERS = ["all", "pending", "running", "waiting_children", "waiting_approval", "completed", "failed"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "badge badge-gray",
    running: "badge badge-blue",
    waiting_children: "badge badge-yellow",
    waiting_approval: "badge badge-yellow",
    approved: "badge badge-green",
    completed: "badge badge-green",
    rejected: "badge badge-red",
    failed: "badge badge-red",
  };
  return <span className={map[status] ?? "badge badge-gray"}>{status}</span>;
}

function relAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function EventKindChip({ kind }: { kind: string }) {
  const color =
    kind === "task.created" ? "var(--accent)"
    : kind === "task.status_changed" ? "var(--yellow)"
    : "var(--text-muted)";
  return <span className="mono" style={{ fontSize: 10, color }}>{kind}</span>;
}

type ArtifactRow = Record<string, unknown>;

function TaskRow({ task, onAssign }: {
  task: Row;
  onAssign: (id: string, agentId: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [events, setEvents] = useState<EventRow[] | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [taskArtifacts, setTaskArtifacts] = useState<ArtifactRow[] | null>(null);
  const [children, setChildren] = useState<Row[] | null>(null);
  const [assignInput, setAssignInput] = useState("");
  const [assigning, setAssigning] = useState(false);

  const id = String(task["id"] ?? "");
  const input = (() => { try { return JSON.parse(String(task["input"] ?? "{}")) as Record<string, unknown>; } catch { return {}; } })();

  const status = String(task["status"] ?? "");

  const loadEvents = async () => {
    if (events !== null) return;
    setEventsLoading(true);
    try {
      const rows = await tasks.events(id) as EventRow[];
      setEvents(rows);
    } catch { setEvents([]); }
    finally { setEventsLoading(false); }
  };

  const loadArtifacts = async () => {
    if (taskArtifacts !== null) return;
    try {
      const rows = await artifacts.list(id) as ArtifactRow[];
      setTaskArtifacts(rows);
    } catch { setTaskArtifacts([]); }
  };

  const loadChildren = async () => {
    if (children !== null) return;
    try {
      const rows = await tasks.children(id) as Row[];
      setChildren(rows);
    } catch { setChildren([]); }
  };

  const handleExpand = () => {
    setExpanded((v) => !v);
    if (!expanded) {
      void loadEvents();
      if (status === "completed") void loadArtifacts();
      if (status === "waiting_children" || !!task["parent_task_id"]) void loadChildren();
    }
  };

  const handleAssign = async () => {
    if (!assignInput.trim()) return;
    setAssigning(true);
    try {
      await onAssign(id, assignInput.trim());
      setAssignInput("");
    } finally {
      setAssigning(false);
    }
  };

  return (
    <>
      <tr
        onClick={handleExpand}
        style={{ cursor: "pointer" }}
      >
        <td><span className="mono">{String(task["kind"] ?? "—")}</span></td>
        <td><StatusBadge status={String(task["status"] ?? "pending")} /></td>
        <td className="truncate" style={{ maxWidth: 220 }}>{String(input["summary"] ?? "—")}</td>
        <td>
          <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {String(task["assigned_agent_id"] ?? "—").slice(0, 12)}{task["assigned_agent_id"] ? "…" : ""}
          </span>
        </td>
        <td style={{ fontSize: 11, color: "var(--text-muted)" }}>{relAge(String(task["created_at"] ?? ""))}</td>
        <td style={{ fontSize: 11, color: "var(--accent)" }}>{expanded ? "▲" : "▼"}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} style={{ background: "var(--bg-elevated)", padding: "12px 16px" }}>
            {/* Re-assign */}
            <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Re-assign:</span>
              <input
                value={assignInput}
                onChange={(e) => setAssignInput(e.target.value)}
                placeholder="agent ID"
                style={{
                  background: "var(--bg-base)", border: "1px solid var(--border)",
                  color: "var(--text-primary)", padding: "3px 8px", borderRadius: "var(--radius-sm)",
                  fontSize: 11, fontFamily: "var(--font-mono)", width: 260,
                }}
              />
              <button
                className="btn btn-primary"
                style={{ fontSize: 11, padding: "3px 10px" }}
                disabled={assigning || !assignInput.trim()}
                onClick={() => void handleAssign()}
              >
                {assigning ? "…" : "Assign"}
              </button>
            </div>

            {/* Sub-tasks (waiting_children or has parent) */}
            {(status === "waiting_children" || !!task["parent_task_id"]) && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>
                  {task["parent_task_id"]
                    ? `Parent: ${String(task["parent_task_id"]).slice(0, 12)}…`
                    : `Sub-tasks (${status === "waiting_children" ? "waiting" : ""})`}
                </div>
                {children === null && (
                  <button className="btn" style={{ fontSize: 10, padding: "2px 8px" }} onClick={() => void loadChildren()}>
                    Load children
                  </button>
                )}
                {children && children.length === 0 && (
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>No sub-tasks.</div>
                )}
                {children && children.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {children.map((c) => {
                      const ci = (() => { try { return JSON.parse(String(c["input"] ?? "{}")); } catch { return {}; } })() as Record<string, unknown>;
                      return (
                        <div key={String(c["id"])} style={{
                          display: "flex", gap: 8, alignItems: "center",
                          background: "var(--bg-base)", border: "1px solid var(--border)",
                          borderRadius: "var(--radius-sm)", padding: "4px 8px", fontSize: 11,
                        }}>
                          <span className="mono" style={{ color: "var(--text-muted)", fontSize: 10 }}>{String(c["kind"] ?? "")}</span>
                          <StatusBadge status={String(c["status"] ?? "pending")} />
                          <span className="truncate" style={{ color: "var(--text-secondary)" }}>{String(ci["summary"] ?? "—")}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Output (completed tasks) */}
            {status === "completed" && taskArtifacts && taskArtifacts.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>Output</div>
                {taskArtifacts.map((a) => {
                  type ToolLogEntry = { name: string; input: unknown; result: unknown; ok: boolean };
                  let parsed: { response?: string; toolCallLog?: ToolLogEntry[] } = {};
                  try { parsed = JSON.parse(String(a["content"] ?? "{}")); } catch { /* raw */ }
                  const responseText = parsed.response ?? String(a["content"] ?? "");
                  const toolLog = parsed.toolCallLog ?? [];
                  return (
                    <div key={String(a["id"])} style={{
                      background: "var(--bg-base)", border: "1px solid var(--border)",
                      borderRadius: "var(--radius-sm)", padding: "8px 10px", marginBottom: 6,
                    }}>
                      <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>
                        {String(a["name"] ?? "")} · {String(a["kind"] ?? "")}
                      </div>
                      {toolLog.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4 }}>Tools used</div>
                          {toolLog.map((t, i) => (
                            <div key={i} style={{
                              display: "flex", gap: 6, alignItems: "flex-start", fontSize: 10,
                              borderLeft: `2px solid ${t.ok ? "var(--accent)" : "var(--red)"}`,
                              paddingLeft: 6, marginBottom: 3,
                            }}>
                              <span className="mono" style={{ color: "var(--accent)", whiteSpace: "nowrap" }}>{t.name}</span>
                              <span style={{ color: "var(--text-muted)" }}>→</span>
                              <span className="truncate" style={{ color: "var(--text-secondary)" }}>
                                {JSON.stringify(t.result).slice(0, 80)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                      <pre style={{
                        margin: 0, fontSize: 11, color: "var(--text-primary)",
                        whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-ui)",
                      }}>
                        {responseText}
                      </pre>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Event timeline */}
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>Event timeline</div>
            {eventsLoading && <div className="loading" style={{ fontSize: 11 }}>loading…</div>}
            {events && events.length === 0 && (
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>No events yet.</div>
            )}
            {events && events.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {events.map((e) => (
                  <div key={String(e["id"])} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <span style={{ color: "var(--text-muted)", fontSize: 10, whiteSpace: "nowrap", paddingTop: 1 }}>
                      {String(e["created_at"] ?? "").slice(11, 19)}
                    </span>
                    <EventKindChip kind={String(e["kind"] ?? "")} />
                    <span style={{ fontSize: 11, color: "var(--text-secondary)" }} className="truncate">
                      {(() => { try { const p = JSON.parse(String(e["payload"] ?? "{}")); return p.note ?? JSON.stringify(p); } catch { return "—"; } })()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function Runs() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");

  const load = (status: StatusFilter) => {
    setLoading(true);
    (tasks.list(status === "all" ? undefined : status) as Promise<Row[]>)
      .then(setRows)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(filter); }, [filter]);

  const handleAssign = async (id: string, agentId: string) => {
    await tasks.assign(id, { agentId });
    load(filter);
  };

  return (
    <div>
      <div className="page-title">Runs</div>
      <div className="page-subtitle">Task execution history — click a row to expand timeline</div>

      {error && (
        <div className="card" style={{ borderColor: "var(--red)", marginBottom: 16 }}>
          <span style={{ color: "var(--red)" }}>⚠ {error}</span>
        </div>
      )}

      {/* Filter bar */}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            style={{
              padding: "4px 12px",
              fontSize: 12,
              borderRadius: "var(--radius-sm)",
              border: `1px solid ${filter === s ? "var(--accent)" : "var(--border)"}`,
              background: filter === s ? "var(--accent-dim)" : "var(--bg-elevated)",
              color: filter === s ? "var(--accent)" : "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="card">
        <div className="card-title">Tasks ({loading ? "…" : rows.length})</div>
        {loading ? (
          <div className="loading">loading…</div>
        ) : rows.length === 0 ? (
          <div className="empty">No tasks{filter !== "all" ? ` with status "${filter}"` : ""}.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Summary</th>
                  <th>Assigned Agent</th>
                  <th>Age</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <TaskRow key={String(t["id"])} task={t} onAssign={handleAssign} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
