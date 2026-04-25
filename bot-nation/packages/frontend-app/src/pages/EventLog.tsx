import { useEffect, useState } from "react";
import { events } from "../api/client";

type EventRow = {
  id: string;
  kind: string;
  actor_id: string | null;
  target_kind: string;
  target_id: string;
  payload: string;
  session_id: string | null;
  created_at: string;
};

function KindBadge({ kind }: { kind: string }) {
  const color =
    kind.startsWith("proposal.applied") ? "var(--green)"
    : kind.startsWith("proposal.failed") ? "var(--red)"
    : kind.startsWith("proposal.") ? "var(--accent)"
    : kind.startsWith("approval.") ? "var(--yellow)"
    : kind.startsWith("agent.") ? "var(--purple)"
    : "var(--text-secondary)";

  return (
    <span className="mono" style={{ fontSize: 11, color, whiteSpace: "nowrap" }}>
      {kind}
    </span>
  );
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function EventLog() {
  const [rows, setRows] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (events.list() as Promise<EventRow[]>)
      .then(setRows)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading">loading events…</div>;

  return (
    <div>
      <div className="page-title">Event Log</div>
      <div className="page-subtitle">Audit trail — every governance action recorded</div>

      {error && (
        <div className="card" style={{ borderColor: "var(--red)", marginBottom: 16 }}>
          <span style={{ color: "var(--red)" }}>⚠ {error}</span>
        </div>
      )}

      <div className="card">
        <div className="card-title">Recent Events ({rows.length})</div>
        {rows.length === 0 ? (
          <div className="empty">No events yet. Submit a proposal to generate events.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Actor</th>
                  <th>Target</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td><KindBadge kind={e.kind} /></td>
                    <td>
                      <span className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {e.actor_id ? e.actor_id.slice(0, 8) + "…" : "system"}
                      </span>
                    </td>
                    <td>
                      <span className="mono" style={{ fontSize: 11, color: "var(--text-secondary)" }}>
                        {e.target_kind}:{e.target_id.slice(0, 8)}…
                      </span>
                    </td>
                    <td style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                      {relativeTime(e.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
