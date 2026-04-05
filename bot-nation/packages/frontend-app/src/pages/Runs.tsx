import { useEffect, useState } from "react";
import { tasks } from "../api/client";

type Row = Record<string, unknown>;

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "badge badge-gray",
    running: "badge badge-blue",
    waiting_approval: "badge badge-yellow",
    approved: "badge badge-green",
    completed: "badge badge-green",
    rejected: "badge badge-red",
    failed: "badge badge-red",
  };
  return <span className={map[status] ?? "badge badge-gray"}>{status}</span>;
}

export function Runs() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (tasks.list() as Promise<Row[]>)
      .then(setRows)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="loading">loading runs…</div>;

  return (
    <div>
      <div className="page-title">Runs</div>
      <div className="page-subtitle">Task execution history and run status</div>

      {error && (
        <div className="card" style={{ borderColor: "var(--red)", marginBottom: 16 }}>
          <span style={{ color: "var(--red)" }}>⚠ {error}</span>
        </div>
      )}

      <div className="card">
        <div className="card-title">Tasks ({rows.length})</div>
        {rows.length === 0 ? (
          <div className="empty">No tasks yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Status</th>
                  <th>Summary</th>
                  <th>Created</th>
                  <th>ID</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  const input = (() => { try { return JSON.parse(String(t["input"] ?? "{}")) as Record<string, unknown>; } catch { return {}; } })();
                  return (
                    <tr key={String(t["id"])}>
                      <td><span className="mono">{String(t["kind"] ?? "—")}</span></td>
                      <td><StatusBadge status={String(t["status"] ?? "pending")} /></td>
                      <td className="truncate">{String(input["summary"] ?? "—")}</td>
                      <td className="mono" style={{ color: "var(--text-muted)", fontSize: 11 }}>
                        {String(t["created_at"] ?? "").slice(0, 16).replace("T", " ")}
                      </td>
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
