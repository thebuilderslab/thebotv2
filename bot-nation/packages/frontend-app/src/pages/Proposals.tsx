import { useEffect, useState } from "react";
import { proposals } from "../api/client";

type Row = Record<string, unknown>;

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    draft: "badge badge-gray",
    pending_approval: "badge badge-yellow",
    approved: "badge badge-green",
    applied: "badge badge-green",
    rejected: "badge badge-red",
    failed: "badge badge-red",
  };
  return <span className={map[status] ?? "badge badge-gray"}>{status}</span>;
}

function RiskBadge({ risk }: { risk: string }) {
  const map: Record<string, string> = {
    low: "badge badge-green",
    medium: "badge badge-yellow",
    high: "badge badge-red",
    critical: "badge badge-red",
  };
  return <span className={map[risk] ?? "badge badge-gray"}>{risk}</span>;
}

export function Proposals() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    (proposals.list() as Promise<Row[]>)
      .then(setRows)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const handleSubmit = async (id: string) => {
    setSubmitting(id);
    try {
      await proposals.submit(id);
      load();
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setSubmitting(null);
    }
  };

  if (loading) return <div className="loading">loading proposals…</div>;

  return (
    <div>
      <div className="page-title">Proposals</div>
      <div className="page-subtitle">Governance proposals — create, review, and approve changes</div>

      {error && (
        <div className="card" style={{ borderColor: "var(--red)", marginBottom: 16 }}>
          <span style={{ color: "var(--red)" }}>⚠ {error}</span>
        </div>
      )}

      <div className="card">
        <div className="card-title">All Proposals ({rows.length})</div>
        {rows.length === 0 ? (
          <div className="empty">No proposals yet. Create one via POST /api/proposals.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Type</th>
                  <th>Target</th>
                  <th>Risk</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={String(p["id"])}>
                    <td className="truncate">{String(p["title"] ?? "—")}</td>
                    <td><span className="mono">{String(p["type"] ?? "—")}</span></td>
                    <td>
                      <span className="mono" style={{ color: "var(--text-muted)" }}>
                        {String(p["target_entity_kind"] ?? "")}:{String(p["target_entity_id"] ?? "").slice(0, 8)}…
                      </span>
                    </td>
                    <td><RiskBadge risk={String(p["risk_level"] ?? "low")} /></td>
                    <td><StatusBadge status={String(p["status"] ?? "draft")} /></td>
                    <td>
                      {String(p["status"]) === "draft" && (
                        <button
                          className="btn btn-primary"
                          style={{ fontSize: 12, padding: "4px 10px" }}
                          disabled={submitting === String(p["id"])}
                          onClick={() => void handleSubmit(String(p["id"]))}
                        >
                          {submitting === String(p["id"]) ? "Submitting…" : "Submit →"}
                        </button>
                      )}
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
