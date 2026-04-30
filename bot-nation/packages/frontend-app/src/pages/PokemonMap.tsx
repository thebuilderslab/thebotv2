import { useEffect, useRef, useState } from "react";
import * as api from "../api/client";
import type { RoomStatusResponse, DeptSummary } from "../api/client";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Agent {
  id: string;
  name: string;
  role: string;
  domain: string;
  status: string;
  team_id: string;
  capabilities: string; // JSON string
}

interface Task {
  id: string;
  kind: string;
  status: string;
  assigned_agent_id: string | null;
  summary: string | null;
  created_at: string;
}

interface ApiEvent {
  id: string;
  kind: string;
  actor_id: string | null;
  target_id: string | null;
  created_at: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEPT_COLORS: Record<string, string> = {
  research:   "#4a9eff",
  intel:      "#7b4aff",
  growth:     "#4aff8a",
  infra:      "#ff8a4a",
  build:      "#ff8a4a",
  supervisor: "#ffd700",
  finance:    "#ff4a4a",
  bailey:     "#4affff",
  p87:        "#ff4aff",
};

function getDeptColor(teamId: string, agentId: string): string {
  if (agentId === "agent-nation-supervisor") return DEPT_COLORS["supervisor"] ?? "#ffd700";
  const parts = teamId?.split("-") ?? [];
  for (const p of parts) {
    const c = DEPT_COLORS[p];
    if (c) return c;
  }
  return "#8892b0";
}

function getInitials(name: string): string {
  const words = name.replace(/^agent-/i, "").split(/[-\s]+/).filter(Boolean);
  if (words.length >= 2) return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase();
  return name.replace(/^agent-/i, "").slice(0, 2).toUpperCase();
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)  return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ─── Room definitions ─────────────────────────────────────────────────────────

interface RoomDef {
  id: string;
  label: string;
  /** Hardcoded rooms that are always live (never go UC) */
  alwaysOn?: boolean;
  /**
   * Team IDs that contribute toward unlocking this room.
   * When combined task_count >= 3 AND has_cron, construction flips to false.
   * Leave empty for always-on rooms.
   */
  watchedTeams: string[];
  constructionTeam?: string;
  agentIds: string[];
  gridArea: string;
}

/**
 * Derives whether a room is still Under Construction based on live API data.
 * Always-on rooms are never UC.
 * Rooms with watchedTeams unlock when: combined task_count >= 3 AND has_cron.
 */
function isUnderConstruction(room: RoomDef, status: RoomStatusResponse | null): boolean {
  if (room.alwaysOn) return false;
  if (!status)        return true;   // loading → show UC until data arrives
  const entry = status.rooms[room.id];
  if (!entry)         return true;   // not tracked yet → UC
  return !entry.unlocked;
}

const ROOMS: RoomDef[] = [
  // Row 1
  {
    id: "uc-finance",
    label: "Finance Dept",
    watchedTeams: ["team-finance"],
    constructionTeam: "team-finance",
    agentIds: ["agent-finance-lead", "agent-finance-analyst"],
    gridArea: "1 / 1 / 2 / 2",
  },
  {
    id: "research-hq",
    label: "Research HQ",
    alwaysOn: true,
    watchedTeams: [],
    agentIds: ["agent-research-lead", "agent-researcher-1", "agent-researcher-2", "agent-intel-lead"],
    gridArea: "1 / 2 / 2 / 3",
  },
  {
    id: "uc-p87",
    label: "P87 Suite",
    watchedTeams: ["team-p87"],
    constructionTeam: "team-p87",
    agentIds: ["agent-p87-planner"],
    gridArea: "1 / 3 / 2 / 4",
  },
  // Row 2 (hallway row)
  {
    id: "uc-bailey",
    label: "Bailey Wing",
    watchedTeams: ["team-bailey"],
    constructionTeam: "team-bailey",
    agentIds: ["agent-bailey-specialist"],
    gridArea: "2 / 1 / 3 / 2",
  },
  {
    id: "hallway",
    label: "Corridor",
    alwaysOn: true,
    watchedTeams: [],
    agentIds: [],
    gridArea: "2 / 2 / 3 / 3",
  },
  {
    id: "archives",
    label: "Archives",
    alwaysOn: true,
    watchedTeams: [],
    agentIds: ["agent-researcher-2"],
    gridArea: "2 / 3 / 3 / 4",
  },
  // Row 3
  {
    id: "agency-lab",
    label: "Agency Lab",
    watchedTeams: ["team-growth", "team-agency"],
    constructionTeam: "team-growth · team-agency · dept-sales",
    agentIds: [
      "agent-growth-lead",
      "agent-growth-social",
      "agent-agency-growthops",
      "agent-agency-pipelineops",
      "agent-agency-revops",
    ],
    gridArea: "3 / 1 / 4 / 2",
  },
  {
    id: "supervisor-desk",
    label: "Supervisor Desk",
    alwaysOn: true,
    watchedTeams: [],
    agentIds: ["agent-nation-supervisor"],
    gridArea: "3 / 2 / 4 / 3",
  },
  {
    id: "infrastructure",
    label: "Infrastructure",
    alwaysOn: true,
    watchedTeams: [],
    agentIds: ["agent-infra-lead", "agent-build-lead", "agent-builder-1", "agent-builder-2"],
    gridArea: "3 / 3 / 4 / 4",
  },
];

// Nav order — construction state derived at render time from roomStatus
const ROOM_NAV_IDS = [
  "research-hq",
  "infrastructure",
  "archives",
  "supervisor-desk",
  "agency-lab",
  "uc-finance",
  "uc-bailey",
  "uc-p87",
];

// ─── Agent Sprite ─────────────────────────────────────────────────────────────

interface AgentSpriteProps {
  agent: Agent | undefined;
  agentId: string;
  runningTask: Task | undefined;
  onClick: () => void;
}

function AgentSprite({ agent, agentId, runningTask, onClick }: AgentSpriteProps) {
  const color = agent ? getDeptColor(agent.team_id, agent.id) : "#4a5270";
  const isActive = agent?.status === "active" || !!runningTask;
  const hasError = agent?.status === "error";
  const initials = agent ? getInitials(agent.name ?? agentId) : getInitials(agentId);

  return (
    <button
      className={`agent-sprite${isActive ? " active" : ""}${hasError ? " error" : ""}`}
      style={{ "--sprite-color": color } as React.CSSProperties}
      onClick={onClick}
      title={agent?.name ?? agentId}
    >
      {initials}
      {isActive && <span className="sprite-status-dot status-active" />}
      {hasError && <span className="sprite-status-dot status-error" />}
    </button>
  );
}

// ─── Agent Brief Panel ────────────────────────────────────────────────────────

interface AgentBriefPanelProps {
  agentId: string | null;
  agents: Agent[];
  tasks: Task[];
  onClose: () => void;
}

function AgentBriefPanel({ agentId, agents, tasks, onClose }: AgentBriefPanelProps) {
  const agent = agents.find((a) => a.id === agentId);
  const runningTask = tasks.find(
    (t) => t.assigned_agent_id === agentId && t.status === "running",
  );
  const recentTasks = tasks
    .filter((t) => t.assigned_agent_id === agentId)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 5);

  const color = agent ? getDeptColor(agent.team_id, agent.id) : "#4a5270";
  const isActive = agent?.status === "active" || !!runningTask;

  let capabilities: string[] = [];
  if (agent?.capabilities) {
    try {
      capabilities = JSON.parse(agent.capabilities) as string[];
    } catch {
      // ignore parse errors
    }
  }

  return (
    <div className={`agent-brief-panel${agentId ? " open" : ""}`}>
      <button className="brief-close" onClick={onClose}>×</button>

      {!agent && agentId && (
        <div className="brief-empty">
          <div className="brief-agent-id">{agentId}</div>
          <div className="brief-no-data">Agent not yet deployed</div>
        </div>
      )}

      {agent && (
        <>
          {/* Header */}
          <div className="brief-header">
            <div
              className={`brief-sprite${isActive ? " active" : ""}`}
              style={{ "--sprite-color": color } as React.CSSProperties}
            >
              {getInitials(agent.name ?? agent.id)}
            </div>
            <div className="brief-agent-info">
              <div className="brief-agent-name">{agent.name ?? agent.id}</div>
              <div className="brief-agent-meta">
                {agent.role} · {agent.team_id ?? "unassigned"}
              </div>
            </div>
          </div>

          {/* Stats */}
          <div className="brief-stats">
            <div className="brief-stat">
              <span className="brief-stat-label">STATUS</span>
              <span
                className="brief-stat-value"
                style={{ color: isActive ? "var(--green)" : "var(--text-secondary)" }}
              >
                {isActive ? "● active" : "○ idle"}
              </span>
            </div>
            <div className="brief-stat">
              <span className="brief-stat-label">TASKS</span>
              <span className="brief-stat-value">{recentTasks.length} recent</span>
            </div>
            <div className="brief-stat">
              <span className="brief-stat-label">DOMAIN</span>
              <span className="brief-stat-value">{agent.domain ?? "—"}</span>
            </div>
          </div>

          {/* Current Task */}
          {runningTask && (
            <div className="brief-section">
              <div className="brief-section-title">CURRENT TASK</div>
              <div className="brief-task-card">
                <div className="brief-task-kind">{runningTask.kind}</div>
                <div className="brief-task-summary">
                  {runningTask.summary ?? "(no summary)"}
                </div>
                <div className="brief-task-time">
                  Started {timeAgo(runningTask.created_at)}
                </div>
              </div>
            </div>
          )}

          {/* Capabilities */}
          {capabilities.length > 0 && (
            <div className="brief-section">
              <div className="brief-section-title">CAPABILITIES</div>
              <div className="brief-caps">
                {capabilities.map((cap) => (
                  <span key={cap} className="brief-cap-pill">{cap}</span>
                ))}
              </div>
            </div>
          )}

          {/* Recent Activity */}
          {recentTasks.length > 0 && (
            <div className="brief-section">
              <div className="brief-section-title">RECENT ACTIVITY</div>
              <ul className="brief-activity">
                {recentTasks.map((t) => (
                  <li key={t.id} className="brief-activity-item">
                    <span
                      className="brief-activity-dot"
                      style={{
                        background:
                          t.status === "done"
                            ? "var(--green)"
                            : t.status === "running"
                              ? "var(--accent)"
                              : "var(--text-muted)",
                      }}
                    />
                    <span className="brief-activity-text">
                      [{t.kind}] {t.summary ?? t.id}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Dept Brief Panel ─────────────────────────────────────────────────────────

interface DeptBriefPanelProps {
  teamId: string | null;
  roomLabel: string;
  onClose: () => void;
  onAgentClick: (id: string) => void;
}

const STATUS_COLOR: Record<string, string> = {
  done:             "var(--green)",
  completed:        "var(--green)",
  running:          "var(--accent)",
  pending:          "#ffd700",
  waiting_children: "#ff8a4a",
  failed:           "#ff4a6e",
  error:            "#ff4a6e",
};

function statusBadge(status: string): React.ReactElement {
  return (
    <span
      className="dept-task-status"
      style={{ background: STATUS_COLOR[status] ?? "var(--text-muted)" }}
    >
      {status}
    </span>
  );
}

function DeptBriefPanel({ teamId, roomLabel, onClose, onAgentClick }: DeptBriefPanelProps) {
  const [data, setData] = useState<DeptSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId) { setData(null); return; }
    setLoading(true);
    setErr(null);
    api.nation.deptSummary(teamId)
      .then((d) => { setData(d); setLoading(false); })
      .catch((e: unknown) => { setErr(String(e)); setLoading(false); });
  }, [teamId]);

  const isOpen = !!teamId;

  return (
    <div className={`agent-brief-panel dept-brief-panel${isOpen ? " open" : ""}`}>
      <button className="brief-close" onClick={onClose}>×</button>

      {loading && (
        <div className="brief-empty"><div className="brief-no-data">Loading…</div></div>
      )}

      {err && (
        <div className="brief-empty"><div className="brief-no-data" style={{ color: "var(--red)" }}>{err}</div></div>
      )}

      {!loading && !err && data && (
        <>
          {/* Header */}
          <div className="brief-header">
            <div
              className="brief-sprite active"
              style={{ "--sprite-color": "#8892b0" } as React.CSSProperties}
            >
              {roomLabel.slice(0, 2).toUpperCase()}
            </div>
            <div className="brief-agent-info">
              <div className="brief-agent-name">{data.team.name}</div>
              <div className="brief-agent-meta">{data.team.domain} · {data.team.memberCount} agents</div>
            </div>
          </div>

          {/* Mission */}
          {data.team.objectives && (
            <div className="brief-section">
              <div className="brief-section-title">MISSION</div>
              <div className="dept-objectives">{data.team.objectives}</div>
            </div>
          )}

          {/* Task counts bar */}
          <div className="brief-stats">
            {(["running","pending","done","completed","failed","error"] as const).map((s) => (
              data.taskCounts[s] ? (
                <div className="brief-stat" key={s}>
                  <span className="brief-stat-label">{s.toUpperCase()}</span>
                  <span className="brief-stat-value" style={{ color: STATUS_COLOR[s] }}>
                    {data.taskCounts[s]}
                  </span>
                </div>
              ) : null
            ))}
          </div>

          {/* Agent roster */}
          {data.agents.length > 0 && (
            <div className="brief-section">
              <div className="brief-section-title">AGENTS</div>
              <ul className="dept-agent-list">
                {data.agents.map((a) => (
                  <li key={a.id} className="dept-agent-item">
                    <button
                      className="dept-agent-btn"
                      onClick={() => onAgentClick(a.id)}
                      title={`Open ${a.name} brief`}
                    >
                      <span
                        className="dept-agent-dot"
                        style={{ background: a.status === "active" ? "var(--green)" : "var(--text-muted)" }}
                      />
                      <span className="dept-agent-name">{a.name}</span>
                      <span className="dept-agent-role">{a.role}</span>
                      {a.id === data.team.leadAgentId && (
                        <span className="dept-lead-badge">lead</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Task list */}
          {data.tasks.length > 0 && (
            <div className="brief-section">
              <div className="brief-section-title">TASKS</div>
              <ul className="dept-task-list">
                {data.tasks.slice(0, 12).map((t) => (
                  <li key={t.id} className="dept-task-item">
                    <div className="dept-task-row">
                      {statusBadge(t.status)}
                      <span className="dept-task-kind">{t.kind}</span>
                      <a
                        className="dept-task-link"
                        href={`/runs?task=${t.id}`}
                        target="_blank"
                        rel="noreferrer"
                        title="Open run"
                      >
                        ↗
                      </a>
                    </div>
                    <div className="dept-task-summary">{t.summary ?? t.id}</div>
                    <div className="dept-task-time">{timeAgo(t.updatedAt ?? t.createdAt)}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Open proposals */}
          {data.proposals.length > 0 && (
            <div className="brief-section">
              <div className="brief-section-title">OPEN PROPOSALS</div>
              <ul className="dept-proposal-list">
                {data.proposals.map((p) => (
                  <li key={p.id} className="dept-proposal-item">
                    <a
                      className="dept-proposal-link"
                      href={`/proposals?id=${p.id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span className="dept-proposal-type">{p.type ?? "proposal"}</span>
                      <span className="dept-proposal-status">{p.status}</span>
                      {p.risk_level && (
                        <span className={`dept-proposal-risk risk-${p.risk_level}`}>{p.risk_level}</span>
                      )}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Map Room ─────────────────────────────────────────────────────────────────

// Resolved room = RoomDef with a computed `construction` boolean
type ResolvedRoom = RoomDef & { construction: boolean };

interface MapRoomProps {
  room: ResolvedRoom;
  agentMap: Map<string, Agent>;
  tasks: Task[];
  highlightId: string | null;
  onAgentClick: (id: string) => void;
  onRoomClick: (room: ResolvedRoom) => void;
}

function MapRoom({ room, agentMap, tasks, highlightId, onAgentClick, onRoomClick }: MapRoomProps) {
  const roomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (highlightId === room.id && roomRef.current) {
      roomRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
      roomRef.current.classList.add("room-highlight");
      setTimeout(() => roomRef.current?.classList.remove("room-highlight"), 1200);
    }
  }, [highlightId, room.id]);

  if (room.id === "hallway") {
    return (
      <div
        className="map-hallway"
        style={{ gridArea: room.gridArea }}
      >
        <span className="hallway-label">— CORRIDOR —</span>
      </div>
    );
  }

  if (room.construction) {
    return (
      <div
        id={room.id}
        ref={roomRef}
        className="map-room map-room-construction"
        style={{ gridArea: room.gridArea }}
      >
        <span className="room-label">{room.label}</span>
        <div className="construction-content">
          <span className="construction-icon">⚠</span>
          <span className="construction-text">UNDER CONSTRUCTION</span>
          {room.constructionTeam && (
            <span className="construction-team">{room.constructionTeam}</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      id={room.id}
      ref={roomRef}
      className="map-room"
      style={{ gridArea: room.gridArea }}
    >
      <button
        className="room-label room-label-btn"
        onClick={() => onRoomClick(room)}
        title={`Open ${room.label} dept view`}
      >
        {room.label}
      </button>
      <div className="room-sprites">
        {room.agentIds.map((agentId) => {
          const agent = agentMap.get(agentId);
          const runningTask = tasks.find(
            (t) => t.assigned_agent_id === agentId && t.status === "running",
          );
          return (
            <AgentSprite
              key={agentId}
              agent={agent}
              agentId={agentId}
              runningTask={runningTask}
              onClick={() => onAgentClick(agentId)}
            />
          );
        })}
        {room.agentIds.length === 0 && (
          <span className="room-empty">Empty</span>
        )}
      </div>
    </div>
  );
}

// ─── Event Ticker ─────────────────────────────────────────────────────────────

interface EventTickerProps {
  events: ApiEvent[];
}

function EventTicker({ events }: EventTickerProps) {
  const items = events.slice(0, 10);
  if (items.length === 0) return null;

  const text = items
    .map((e) => `● ${e.actor_id ?? "system"} · ${e.kind}`)
    .join("   ·   ");

  return (
    <div className="event-ticker">
      <span className="ticker-label">LIVE</span>
      <div className="ticker-track">
        <span className="ticker-content">{text}&nbsp;&nbsp;&nbsp;&nbsp;{text}</span>
      </div>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function PokemonMap() {
  const [agentList,   setAgentList]   = useState<Agent[]>([]);
  const [taskList,    setTaskList]    = useState<Task[]>([]);
  const [eventList,   setEventList]   = useState<ApiEvent[]>([]);
  const [roomStatus,  setRoomStatus]  = useState<RoomStatusResponse | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedRoom,  setSelectedRoom]  = useState<ResolvedRoom | null>(null);
  const [highlightRoom, setHighlightRoom] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Build a quick lookup from agentId → Agent
  const agentMap = new Map(agentList.map((a) => [a.id, a]));

  // Derive room definitions with live construction flag
  const resolvedRooms = ROOMS.map((room) => ({
    ...room,
    construction: isUnderConstruction(room, roomStatus),
  }));

  // Build nav from resolved rooms (skip hallway from nav)
  const navRooms = ROOM_NAV_IDS
    .map((id) => resolvedRooms.find((r) => r.id === id))
    .filter((r): r is typeof resolvedRooms[number] => !!r && r.id !== "hallway");

  // ── Data loading ────────────────────────────────────────────────────────────

  useEffect(() => {
    void loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll agent statuses + room unlock conditions every 15s
  useEffect(() => {
    const id = setInterval(() => {
      void loadAgents();
      void loadTasks();
      void loadRoomStatus();
    }, 15_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll events every 30s
  useEffect(() => {
    const id = setInterval(() => void loadEvents(), 30_000);
    return () => clearInterval(id);
  }, []);

  async function loadAll() {
    await Promise.all([
      loadAgents(),
      loadTasks(),
      loadEvents(),
      loadRoomStatus(),
    ]).catch((e: unknown) => setError(String(e)));
  }

  async function loadAgents() {
    try {
      setAgentList(await api.agents.list() as Agent[]);
    } catch (e) {
      setError(String(e));
    }
  }

  async function loadTasks() {
    try {
      setTaskList(await api.tasks.list() as Task[]);
    } catch (e) {
      console.warn("tasks load failed", e);
    }
  }

  async function loadEvents() {
    try {
      setEventList(await api.events.list() as ApiEvent[]);
    } catch (e) {
      console.warn("events load failed", e);
    }
  }

  async function loadRoomStatus() {
    try {
      setRoomStatus(await api.nation.roomStatus());
    } catch (e) {
      // non-fatal — rooms just stay UC until API responds
      console.warn("room-status load failed", e);
    }
  }

  function handleRoomNav(roomId: string) {
    setHighlightRoom(roomId);
    document.getElementById(roomId)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setTimeout(() => setHighlightRoom(null), 1400);
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const liveRoomCount = resolvedRooms.filter((r) => !r.construction && r.id !== "hallway").length;
  const ucRoomCount   = resolvedRooms.filter((r) =>  r.construction).length;

  return (
    <div className="pokemon-map-page">
      {/* Page header */}
      <div className="map-page-header">
        <div>
          <div className="page-title">Bot-Nation HQ</div>
          <div className="page-subtitle">
            {agentList.length} agents · {liveRoomCount} rooms live · {ucRoomCount} under construction
          </div>
        </div>
        {error && <div className="map-error">⚠ {error}</div>}
      </div>

      {/* Room nav — construction state is live */}
      <div className="map-room-nav">
        {navRooms.map((r) => (
          <button
            key={r.id}
            className={`room-nav-btn${r.construction ? " construction" : ""}`}
            onClick={() => handleRoomNav(r.id)}
            title={
              r.construction && roomStatus?.rooms[r.id]
                ? `Tasks: ${roomStatus.rooms[r.id]!.task_count}/3 · Cron: ${roomStatus.rooms[r.id]!.has_cron ? "✓" : "✗"}`
                : r.label
            }
          >
            {r.construction ? "🚧 " : ""}{r.label}
          </button>
        ))}
      </div>

      {/* Map grid + brief panel */}
      <div className="map-and-panel">
        <div className="pokemon-map">
          {resolvedRooms.map((room) => (
            <MapRoom
              key={room.id}
              room={room}
              agentMap={agentMap}
              tasks={taskList}
              highlightId={highlightRoom}
              onAgentClick={(id) => { setSelectedAgent(id); setSelectedRoom(null); }}
              onRoomClick={(r) => { setSelectedRoom(r); setSelectedAgent(null); }}
            />
          ))}
        </div>

        {/* Agent brief panel — opens on agent sprite click */}
        <AgentBriefPanel
          agentId={selectedAgent}
          agents={agentList}
          tasks={taskList}
          onClose={() => setSelectedAgent(null)}
        />

        {/* Dept brief panel — opens on room label click */}
        <DeptBriefPanel
          teamId={selectedRoom?.watchedTeams[0] ?? null}
          roomLabel={selectedRoom?.label ?? ""}
          onClose={() => setSelectedRoom(null)}
          onAgentClick={(id) => { setSelectedAgent(id); setSelectedRoom(null); }}
        />
      </div>

      {/* Event ticker */}
      <EventTicker events={eventList} />
    </div>
  );
}
