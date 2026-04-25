import { useEffect, useState } from "react";
import { approvals } from "../api/client";

type InboxRow = {
  id: string;
  brief: string;
  status: string;
  created_at: string;
  proposal_id: string | null;
  proposal_title: string | null;
  proposal_type: string | null;
  risk_level: string | null;
  target_entity_kind: string | null;
  target_entity_id: string | null;
  change_set: string | null;
};

function RiskBadge({ risk }: { risk: string | null }) {
  if (!risk) return null;
  const map: Record<string, string> = {
    low: "badge badge-green",
    medium: "badge badge-yellow",
    high: "badge badge-red",
    critical: "badge badge-red",
  };
  return <span className={map[risk] ?? "badge badge-gray"}>{risk}</span>;
}

export function ApprovalsInbox() {
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    (approvals.inbox() as Promise<InboxRow[]>)
      .then(setRows)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const decide = async (id: string, decision: "approved" | "rejected") => {
    setActing(id);
    try {
      await approvals.decide(id, {
        decision,
        userId: "web-user",
        channel: "dashboard",
      });
      load();
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setActing(null);
    }
  };

  if (loading) return <div className="loading">loading inbox…</div>;

  return (
    <div>
      <div className="page-title">Approval Inbox</div>
      <div className="page-subtitle">Pending decisions — approve or reject to apply changeSets</div>

      {error && (
        <div className="card" style={{ borderColor: "var(--red)", marginBottom: 16 }}>
          <span style={{ color: "var(--red)" }}>⚠ {error}</span>
        </div>
      )}

      <div className="card">
        <div className="card-title">Pending ({rows.length})</div>
        {rows.length === 0 ? (
          <div className="empty">No pending approvals. The nation is at rest.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Proposal</th>
                  <th>Type</th>
                  <th>Target</th>
                  <th>Risk</th>
                  <th>Summary</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  let briefSummary = "—";
                  try {
                    const b = JSON.parse(row.brief) as { summary?: string };
                    briefSummary = b.summary ?? "—";
                  } catch { /* ignore */ }

                  return (
                    <tr key={row.id}>
                      <td className="truncate" style={{ maxWidth: 200 }}>
                        {row.proposal_title ?? <span className="mono" style={{ color: "var(--text-muted)" }}>{row.id.slice(0, 8)}…</span>}
                      </td>
                      <td>
                        {row.proposal_type
                          ? <span className="mono">{row.proposal_type}</span>
                          : <span style={{ color: "var(--text-muted)" }}>—</span>}
                      </td>
                      <td>
                        {row.target_entity_kind
                          ? <span className="mono" style={{ color: "var(--text-muted)" }}>
                              {row.target_entity_kind}:{(row.target_entity_id ?? "").slice(0, 8)}…
                            </span>
                          : <span style={{ color: "var(--text-muted)" }}>—</span>}
                      </td>
                      <td><RiskBadge risk={row.risk_level} /></td>
                      <td className="truncate" style={{ maxWidth: 240, color: "var(--text-secondary)", fontSize: 12 }}>
                        {briefSummary}
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            className="btn btn-primary"
                            style={{ fontSize: 12, padding: "4px 10px" }}
                            disabled={acting === row.id}
                            onClick={() => void decide(row.id, "approved")}
                          >
                            {acting === row.id ? "…" : "Approve"}
                          </button>
                          <button
                            className="btn"
                            style={{ fontSize: 12, padding: "4px 10px", background: "var(--bg-elevated)", color: "var(--red)", border: "1px solid var(--red)" }}
                            disabled={acting === row.id}
                            onClick={() => void decide(row.id, "rejected")}
                          >
                            Reject
                          </button>
                        </div>
                      </td>
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
