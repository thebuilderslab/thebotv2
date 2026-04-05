import { useEffect, useState } from "react";
import { agents, teams } from "../api/client";

type Row = Record<string, unknown>;

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "active" ? "badge badge-green"
    : status === "paused" ? "badge badge-yellow"
    : "badge badge-gray";
  return <span className={cls}>{status}</span>;
}

export function AgentsTeams() {
  const [agentRows, setAgentRows] = useState<Row[]>([]);
  const [teamRows, setTeamRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([agents.list() as Promise<Row[]>, teams.list() as Promise<Row[]>])
      .then(([a, t]) => { setAgentRows(a); setTeamRows(t); })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading">loading agents &amp; teams…</div>;

  return (
    <div>
      <div className="page-title">Agents &amp; Teams</div>
      <div className="page-subtitle">All registered agents and team configurations</div>

      {error && (
        <div className="card" style={{ borderColor: "var(--red)", marginBottom: 16 }}>
          <span style={{ color: "var(--red)" }}>⚠ {error}</span>
        </div>
      )}

      {/* ── Agents ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">Agents ({agentRows.length})</div>
        {agentRows.length === 0 ? (
          <div className="empty">No agents yet. Create one via POST /api/agents.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Domain</th>
                  <th>Status</th>
                  <th>Team</th>
                  <th>ID</th>
                </tr>
              </thead>
              <tbody>
                {agentRows.map((a) => (
                  <tr key={String(a["id"])}>
                    <td>{String(a["name"] ?? "—")}</td>
                    <td><span className="mono">{String(a["role"] ?? "—")}</span></td>
                    <td><span className="mono">{String(a["domain"] ?? "—")}</span></td>
                    <td><StatusBadge status={String(a["status"] ?? "unknown")} /></td>
                    <td className="mono truncate">{String(a["team_id"] ?? "—")}</td>
                    <td className="mono truncate" style={{ color: "var(--text-muted)" }}>{String(a["id"] ?? "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Teams ── */}
      <div className="card">
        <div className="card-title">Teams ({teamRows.length})</div>
        {teamRows.length === 0 ? (
          <div className="empty">No teams yet. Create one via POST /api/teams.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Domain</th>
                  <th>Lead Agent</th>
                  <th>Members</th>
                  <th>ID</th>
                </tr>
              </thead>
              <tbody>
                {teamRows.map((t) => {
                  const members = (() => { try { return (JSON.parse(String(t["member_ids"] ?? "[]")) as unknown[]).length; } catch { return 0; } })();
                  return (
                    <tr key={String(t["id"])}>
                      <td>{String(t["name"] ?? "—")}</td>
                      <td><span className="mono">{String(t["domain"] ?? "—")}</span></td>
                      <td className="mono truncate">{String(t["lead_agent_id"] ?? "—")}</td>
                      <td>{members}</td>
                      <td className="mono truncate" style={{ color: "var(--text-muted)" }}>{String(t["id"] ?? "")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
