/**
 * DeFi / projecT87 dashboard — a control-plane section inside the bot-nation console.
 * Merged from the projecT87 standalone dashboard reference into the single console UI.
 *
 * Read-only views (vault health, notifications) are live when the integration is wired.
 * The borrow panel is EXPERIMENTAL and APPROVAL-GATED: it records intent only and never
 * executes on-chain (non-autonomous).
 */
import { useCallback, useEffect, useState } from "react";
import {
  p87,
  type P87Status,
  type P87VaultHealth,
  type P87Notification,
  type P87BorrowResult,
} from "../api/client";

function fmt$(n: number, d = 2) {
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: d, maximumFractionDigits: d });
}

function hfColor(hf: number): string {
  if (hf < 1.5) return "var(--red)";
  if (hf < 2.0) return "var(--yellow, #d5a021)";
  return "var(--green)";
}

function HealthBar({ h }: { h: P87VaultHealth }) {
  return (
    <div className="stat-grid" style={{ marginBottom: 24 }}>
      <div className="stat-card">
        <div className="stat-value" style={{ color: hfColor(h.health_factor) }}>{h.health_factor.toFixed(2)}</div>
        <div className="stat-label">Health Factor</div>
      </div>
      <div className="stat-card">
        <div className="stat-value">{fmt$(h.total_collateral_usd)}</div>
        <div className="stat-label">Collateral</div>
      </div>
      <div className="stat-card">
        <div className="stat-value">{fmt$(h.total_debt_usd)}</div>
        <div className="stat-label">Debt</div>
      </div>
      <div className="stat-card">
        <div className="stat-value">{fmt$(h.net_worth_usd)}</div>
        <div className="stat-label">Net Worth</div>
      </div>
      <div className="stat-card">
        <div className="stat-value">{fmt$(h.available_borrows_usd)}</div>
        <div className="stat-label">Available to Borrow</div>
      </div>
    </div>
  );
}

function BorrowPanel() {
  const [amount, setAmount] = useState<number>(100);
  const [asset, setAsset] = useState<string>("DAI");
  const [result, setResult] = useState<P87BorrowResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setErr(null); setResult(null);
    try {
      setResult(await p87.requestBorrow(amount, asset));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" style={{ marginBottom: 16, borderColor: "var(--yellow, #d5a021)" }}>
      <div className="card-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span>Credit / Borrow</span>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--yellow, #d5a021)" }}>EXPERIMENTAL · APPROVAL-GATED · NON-AUTONOMOUS</span>
      </div>
      <p style={{ color: "var(--fg-muted)", fontSize: 12, margin: "8px 0 12px" }}>
        Submitting records the request for human approval only — it does <strong>not</strong> execute an on-chain borrow.
      </p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="number" min={1} max={10000} value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          style={{ width: 120 }} aria-label="amount"
        />
        <select value={asset} onChange={(e) => setAsset(e.target.value)} aria-label="asset">
          <option value="DAI">DAI</option>
          <option value="USDC">USDC</option>
          <option value="USDT">USDT</option>
        </select>
        <button onClick={submit} disabled={busy}>
          {busy ? "Submitting…" : "Request Borrow (approval required)"}
        </button>
      </div>
      {err && <p style={{ color: "var(--red)", fontSize: 12, marginTop: 10 }}>{err}</p>}
      {result && (
        <p style={{ color: "var(--fg-muted)", fontSize: 12, marginTop: 10 }}>
          <strong>{result.status}</strong> · executed: {String(result.executed)} · {result.note}
        </p>
      )}
    </div>
  );
}

export function DefiDashboard() {
  const [status, setStatus] = useState<P87Status | null>(null);
  const [vault, setVault] = useState<P87VaultHealth | null>(null);
  const [notifs, setNotifs] = useState<P87Notification[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setErr(null);
    try {
      const st = await p87.status();
      setStatus(st);
      if (st.configured) {
        const [v, n] = await Promise.all([p87.vaultHealth(), p87.notifications()]);
        setVault(v);
        setNotifs(n.notifications);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>DeFi · projecT87</h1>
        <button onClick={() => void load()} disabled={loading}>{loading ? "Loading…" : "Refresh"}</button>
      </div>

      {status && !status.configured && (
        <div className="card" style={{ marginBottom: 16, borderColor: "var(--yellow, #d5a021)" }}>
          <div className="card-title">NOT WIRED</div>
          <p style={{ color: "var(--fg-muted)", fontSize: 13 }}>
            projecT87 is vendored but not yet connected. Set <code>PROJECT87_API_URL</code> and the
            <code> PROJECT87_API_KEY</code> secret to enable live DeFi data.
          </p>
        </div>
      )}

      {err && <div className="card" style={{ marginBottom: 16 }}><p style={{ color: "var(--red)" }}>{err}</p></div>}

      {vault && <HealthBar h={vault} />}

      {status?.configured && <BorrowPanel />}

      {status?.configured && (
        <div className="card">
          <div className="card-title">Notifications</div>
          {notifs.length === 0 ? (
            <p style={{ color: "var(--fg-muted)", fontSize: 13 }}>No notifications.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {notifs.map((n) => (
                <li key={n.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--border, #222)" }}>
                  <strong>{n.title}</strong>
                  <span style={{ color: "var(--fg-muted)", fontSize: 11, marginLeft: 8 }}>{n.priority} · {n.created_at}</span>
                  <div style={{ color: "var(--fg-muted)", fontSize: 13 }}>{n.message}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
