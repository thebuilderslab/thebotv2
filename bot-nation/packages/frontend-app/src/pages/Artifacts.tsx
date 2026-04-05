import { useEffect, useState } from "react";
import { artifacts } from "../api/client";

type Row = Record<string, unknown>;

const KINDS = ["all", "code_diff", "config_patch", "test_report", "simulation_report", "design_doc", "log", "other"] as const;
type KindFilter = (typeof KINDS)[number];

function KindBadge({ kind }: { kind: string }) {
  const color =
    kind === "code_diff" ? "var(--accent)"
    : kind === "test_report" ? "var(--green)"
    : kind === "log" ? "var(--text-muted)"
    : kind === "config_patch" ? "var(--yellow)"
    : "var(--text-secondary)";
  return <span className="mono" style={{ fontSize: 11, color }}>{kind}</span>;
}

function relAge(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function Artifacts() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ kind: "log", name: "", url: "", taskId: "" });
  const [submitting, setSubmitting] = useState(false);

  const load = (kind: KindFilter) => {
    setLoading(true);
    (artifacts.list(undefined, kind === "all" ? undefined : kind) as Promise<Row[]>)
      .then(setRows)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(kindFilter); }, [kindFilter]);

  const handleCreate = async () => {
    if (!form.name) return;
    setSubmitting(true);
    try {
      await artifacts.create({
        kind: form.kind,
        name: form.name,
        url: form.url || undefined,
        taskId: form.taskId || undefined,
      });
      setForm({ kind: "log", name: "", url: "", taskId: "" });
      setShowForm(false);
      load(kindFilter);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <div className="page-title">Artifacts</div>
      <div className="page-subtitle">Stored outputs — logs, diffs, reports, design docs</div>

      {error && (
        <div className="card" style={{ borderColor: "var(--red)", marginBottom: 16 }}>
          <span style={{ color: "var(--red)" }}>⚠ {error}</span>
        </div>
      )}

      {/* Filter + Add */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
        {KINDS.map((k) => (
          <button key={k} onClick={() => setKindFilter(k)} style={{
            padding: "4px 10px", fontSize: 11, borderRadius: "var(--radius-sm)",
            border: `1px solid ${kindFilter === k ? "var(--accent)" : "var(--border)"}`,
            background: kindFilter === k ? "var(--accent-dim)" : "var(--bg-elevated)",
            color: kindFilter === k ? "var(--accent)" : "var(--text-secondary)", cursor: "pointer",
          }}>{k}</button>
        ))}
        <button className="btn btn-primary" style={{ marginLeft: "auto", fontSize: 12, padding: "4px 12px" }}
          onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "+ Add Artifact"}
        </button>
      </div>

      {/* Inline add form */}
      {showForm && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-title">New Artifact</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            {[
              { label: "Kind", field: "kind", type: "select" },
              { label: "Name *", field: "name", type: "text" },
              { label: "URL", field: "url", type: "text" },
              { label: "Task ID", field: "taskId", type: "text" },
            ].map(({ label, field, type }) => (
              <div key={field}>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>{label}</div>
                {type === "select" ? (
                  <select value={form[field as keyof typeof form]}
                    onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
                    style={{ width: "100%", background: "var(--bg-base)", border: "1px solid var(--border)", color: "var(--text-primary)", padding: "4px 8px", borderRadius: "var(--radius-sm)", fontSize: 12 }}>
                    {["log","code_diff","config_patch","test_report","simulation_report","design_doc","other"].map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                ) : (
                  <input value={form[field as keyof typeof form]}
                    onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
                    placeholder={field === "url" ? "https://…" : field === "taskId" ? "uuid" : ""}
                    style={{ width: "100%", background: "var(--bg-base)", border: "1px solid var(--border)", color: "var(--text-primary)", padding: "4px 8px", borderRadius: "var(--radius-sm)", fontSize: 12, fontFamily: "var(--font-ui)" }} />
                )}
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-primary" style={{ fontSize: 12, padding: "5px 14px" }}
              disabled={submitting || !form.name} onClick={() => void handleCreate()}>
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-title">Artifacts ({loading ? "…" : rows.length})</div>
        {loading ? <div className="loading">loading…</div>
        : rows.length === 0 ? <div className="empty">No artifacts yet.</div>
        : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Kind</th><th>Name</th><th>URL</th><th>Task</th><th>Age</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={String(r["id"])}>
                    <td><KindBadge kind={String(r["kind"] ?? "other")} /></td>
                    <td>{String(r["name"] ?? "—")}</td>
                    <td>
                      {r["url"] && String(r["url"]) !== "" ? (
                        <a href={String(r["url"])} target="_blank" rel="noreferrer"
                          className="mono" style={{ fontSize: 11, color: "var(--accent)" }}>
                          {String(r["url"]).slice(0, 40)}{String(r["url"]).length > 40 ? "…" : ""}
                        </a>
                      ) : <span style={{ color: "var(--text-muted)" }}>—</span>}
                    </td>
                    <td className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {r["task_id"] ? String(r["task_id"]).slice(0, 8) + "…" : "—"}
                    </td>
                    <td style={{ fontSize: 11, color: "var(--text-muted)" }}>
                      {relAge(String(r["created_at"] ?? ""))}
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
