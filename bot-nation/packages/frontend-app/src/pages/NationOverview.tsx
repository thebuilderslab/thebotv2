import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { agents, teams, proposals, approvals } from "../api/client";

interface Counts {
  agents: number;
  teams: number;
  proposals: number;
  pendingApprovals: number;
}

export function NationOverview() {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      agents.list(),
      teams.list(),
      proposals.list(),
      approvals.list(),
    ])
      .then(([a, t, p, ap]) => {
        const pending = (ap as { status: string }[]).filter(
          (x) => x.status === "pending",
        ).length;
        setCounts({
          agents: a.length,
          teams: t.length,
          proposals: p.length,
          pendingApprovals: pending,
        });
      })
      .catch((e: unknown) => setError(String(e)));
  }, []);

  return (
    <div>
      <div className="page-title">Nation Overview</div>
      <div className="page-subtitle">Live state of the bot-nation governed agent OS</div>

      {error && (
        <div className="card" style={{ borderColor: "var(--red)", marginBottom: 16 }}>
          <span style={{ color: "var(--red)" }}>⚠ {error}</span>
        </div>
      )}

      <div className="stat-grid">
        <div className="stat-card">
          <div className="stat-value">{counts?.agents ?? "—"}</div>
          <div className="stat-label">Agents</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{counts?.teams ?? "—"}</div>
          <div className="stat-label">Teams</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{counts?.proposals ?? "—"}</div>
          <div className="stat-label">Proposals</div>
        </div>
        <Link to="/inbox" style={{ textDecoration: "none" }}>
          <div className="stat-card" style={{ cursor: "pointer" }}>
            <div className="stat-value" style={{ color: counts?.pendingApprovals ? "var(--yellow)" : undefined }}>
              {counts?.pendingApprovals ?? "—"}
            </div>
            <div className="stat-label">Pending Approvals ↗</div>
          </div>
        </Link>
      </div>

      <div className="card">
        <div className="card-title">System Layers</div>
        {[
          ["Governance", "Policy engine, approval gating", "var(--green)"],
          ["Orchestration", "Task routing, workflow coordination", "var(--accent)"],
          ["Knowledge / Graph", "Artifacts, run logs, relationships", "var(--purple)"],
          ["Improvement", "Eval agents, benchmarks, rollback", "var(--yellow)"],
          ["Domain Teams", "Research, Build, Security, Product, Growth, Infra, Finance", "var(--text-secondary)"],
          ["Interface", "Telegram approval bot, web console", "var(--accent)"],
          ["Tool / Protocol", "MCP registry, A2A routing", "var(--text-muted)"],
        ].map(([name, desc, color]) => (
          <div key={name} style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: color, marginTop: 6, flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>{name}</div>
              <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>{desc}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
