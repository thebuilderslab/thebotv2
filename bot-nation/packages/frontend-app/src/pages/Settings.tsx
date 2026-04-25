import { useEffect, useState } from "react";
import { health, stats } from "../api/client";

export function Settings() {
  const [apiStatus, setApiStatus] = useState<"checking" | "ok" | "error">("checking");
  const [counts, setCounts] = useState<Record<string, number> | null>(null);

  useEffect(() => {
    health.check()
      .then(() => setApiStatus("ok"))
      .catch(() => setApiStatus("error"));

    (stats.get() as Promise<Record<string, number>>)
      .then(setCounts)
      .catch(() => { /* non-fatal */ });
  }, []);

  const apiUrl =
    import.meta.env["VITE_API_URL"] ??
    "https://bot-nation-api.thejamalshackleford.workers.dev";

  return (
    <div>
      <div className="page-title">Settings</div>
      <div className="page-subtitle">System configuration and connection status</div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">API Connection</div>
        <table>
          <tbody>
            <tr>
              <td style={{ width: 160 }}>Worker URL</td>
              <td className="mono">{apiUrl}</td>
            </tr>
            <tr>
              <td>Health check</td>
              <td>
                {apiStatus === "checking" && <span className="badge badge-gray">checking…</span>}
                {apiStatus === "ok"       && <span className="badge badge-green">✓ ok</span>}
                {apiStatus === "error"    && <span className="badge badge-red">✗ unreachable</span>}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">Build Info</div>
        <table>
          <tbody>
            {[
              ["Phase", "3 — Knowledge & Memory"],
              ["Backend", "Cloudflare Worker + D1"],
              ["Database", "pbot-nation-db (D1)"],
              ["Approval channel", "Telegram + Dashboard"],
              ["Frontend", "Vite + React 19"],
              ["Cron", "*/5 * * * * (task dispatcher)"],
            ].map(([k, v]) => (
              <tr key={k}>
                <td style={{ width: 160 }}>{k}</td>
                <td style={{ color: "var(--text-secondary)" }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {counts && (
        <div className="card">
          <div className="card-title">Knowledge Counts</div>
          <div className="stat-grid" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
            {Object.entries(counts).map(([key, val]) => (
              <div key={key} className="stat-card">
                <div className="stat-value">{val}</div>
                <div className="stat-label">{key}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
