import { useEffect, useState, useCallback } from "react";
import {
  finance,
  type SchwabPosition,
  type SchwabAccountSummary,
  type PortfolioTotals,
  type SchwabQuote,
  type PriceTarget,
} from "../api/client";

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt$(n: number, decimals = 2) {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtPct(n: number) {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function pnlColor(n: number): string {
  if (n > 0) return "var(--green)";
  if (n < 0) return "var(--red)";
  return "var(--fg-muted)";
}

function trendIcon(trend: string): string {
  if (trend === "bullish") return "🟢";
  if (trend === "bearish") return "🔴";
  return "🟡";
}

// ── Sub-components ────────────────────────────────────────────────────────────

function TotalsBar({ totals }: { totals: PortfolioTotals }) {
  return (
    <div className="stat-grid" style={{ marginBottom: 24 }}>
      <div className="stat-card">
        <div className="stat-value">{fmt$(totals.total_value)}</div>
        <div className="stat-label">Total Value</div>
      </div>
      <div className="stat-card">
        <div className="stat-value" style={{ color: pnlColor(totals.total_day_pnl) }}>
          {totals.total_day_pnl >= 0 ? "+" : ""}{fmt$(totals.total_day_pnl)}
        </div>
        <div className="stat-label">Day P&amp;L</div>
      </div>
      <div className="stat-card">
        <div className="stat-value" style={{ color: pnlColor(totals.total_unrealized_pnl) }}>
          {totals.total_unrealized_pnl >= 0 ? "+" : ""}{fmt$(totals.total_unrealized_pnl)}
        </div>
        <div className="stat-label">Unrealized</div>
      </div>
      <div className="stat-card">
        <div className="stat-value">{fmt$(totals.total_invested)}</div>
        <div className="stat-label">Invested</div>
      </div>
      <div className="stat-card">
        <div className="stat-value">{fmt$(totals.total_cash)}</div>
        <div className="stat-label">Cash</div>
      </div>
    </div>
  );
}

function AccountCard({
  account,
  positions,
  quotes,
  targets,
}: {
  account: SchwabAccountSummary;
  positions: SchwabPosition[];
  quotes: Record<string, SchwabQuote>;
  targets: Record<string, PriceTarget>;
}) {
  const acctPositions = positions.filter((p) => p.account_number === account.account_number);
  const sign = account.day_pnl >= 0 ? "+" : "";

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div
        className="card-title"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}
      >
        <span>
          {account.account_label}
          <span style={{ color: "var(--fg-muted)", fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
            ...{account.account_number}
          </span>
        </span>
        <span style={{ fontSize: 13, fontWeight: 400 }}>
          <span style={{ color: "var(--fg-muted)" }}>Value </span>
          <strong>{fmt$(account.liquidation_value)}</strong>
          <span style={{ color: "var(--fg-muted)", marginLeft: 12 }}>Day </span>
          <strong style={{ color: pnlColor(account.day_pnl) }}>
            {sign}{fmt$(account.day_pnl)}
          </strong>
          <span style={{ color: "var(--fg-muted)", marginLeft: 12 }}>Cash </span>
          <strong>{fmt$(account.cash_balance)}</strong>
        </span>
      </div>

      {acctPositions.length === 0 ? (
        <div className="empty">No positions in this account.</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Qty</th>
                <th>Avg Cost</th>
                <th>Price</th>
                <th>Mkt Value</th>
                <th>Day P&amp;L</th>
                <th>Unrealized</th>
                <th>Daily Target</th>
                <th>Trend</th>
              </tr>
            </thead>
            <tbody>
              {acctPositions.map((pos) => {
                const q = quotes[pos.symbol];
                const t = targets[pos.symbol];
                const price = q?.last_price ?? pos.average_price;
                const chg   = q?.change_pct;

                return (
                  <tr key={`${pos.account_number}-${pos.symbol}`}>
                    <td>
                      <strong style={{ color: "var(--accent)" }}>{pos.symbol}</strong>
                      {pos.asset_type !== "EQUITY" && (
                        <span style={{ color: "var(--fg-muted)", fontSize: 11, marginLeft: 4 }}>
                          {pos.asset_type}
                        </span>
                      )}
                    </td>
                    <td>{pos.quantity}</td>
                    <td style={{ color: "var(--fg-muted)" }}>{fmt$(pos.average_price)}</td>
                    <td>
                      {fmt$(price)}
                      {chg !== undefined && (
                        <span
                          style={{
                            marginLeft: 4,
                            fontSize: 11,
                            color: pnlColor(chg),
                          }}
                        >
                          {fmtPct(chg)}
                        </span>
                      )}
                    </td>
                    <td>{fmt$(pos.market_value)}</td>
                    <td style={{ color: pnlColor(pos.current_day_pnl) }}>
                      {pos.current_day_pnl >= 0 ? "+" : ""}{fmt$(pos.current_day_pnl)}
                      <span style={{ color: "var(--fg-muted)", fontSize: 11, marginLeft: 4 }}>
                        ({fmtPct(pos.current_day_pnl_pct)})
                      </span>
                    </td>
                    <td style={{ color: pnlColor(pos.unrealized_pnl) }}>
                      {pos.unrealized_pnl >= 0 ? "+" : ""}{fmt$(pos.unrealized_pnl)}
                    </td>
                    <td>
                      {t ? (
                        <span style={{ color: "var(--accent)" }}>{fmt$(t.daily_target)}</span>
                      ) : (
                        <span style={{ color: "var(--fg-muted)" }}>—</span>
                      )}
                    </td>
                    <td>
                      {t ? (
                        <span title={t.reasoning}>
                          {trendIcon(t.trend)} {t.trend}
                        </span>
                      ) : (
                        <span style={{ color: "var(--fg-muted)" }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function FinanceDashboard() {
  const [accounts, setAccounts]         = useState<SchwabAccountSummary[]>([]);
  const [positions, setPositions]       = useState<SchwabPosition[]>([]);
  const [totals, setTotals]             = useState<PortfolioTotals | null>(null);
  const [quotes, setQuotes]             = useState<Record<string, SchwabQuote>>({});
  const [targets, setTargets]           = useState<Record<string, PriceTarget>>({});
  const [syncedAt, setSyncedAt]         = useState<string | null>(null);
  const [loading, setLoading]           = useState(true);
  const [syncing, setSyncing]           = useState(false);
  const [refreshingTgts, setRefreshingTgts] = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [statusMsg, setStatusMsg]       = useState<string | null>(null);

  // Load stored positions + targets
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [posData, tgtData] = await Promise.all([
        finance.positions(),
        finance.targets(),
      ]);
      setAccounts(posData.accounts);
      setPositions(posData.positions);
      setTotals(posData.totals);
      setSyncedAt(posData.synced_at);

      const tMap: Record<string, PriceTarget> = {};
      for (const t of tgtData.targets) tMap[t.symbol] = t;
      setTargets(tMap);

      // Fetch quotes for held symbols
      const symbols = [...new Set(posData.positions.map((p) => p.symbol))];
      if (symbols.length > 0) {
        try {
          const qData = await finance.quotes(symbols.join(","));
          const qMap: Record<string, SchwabQuote> = {};
          for (const q of qData.quotes) qMap[q.symbol] = q;
          setQuotes(qMap);
        } catch {
          // Quotes are best-effort — don't block the rest of the page
        }
      }
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
    // Refresh quotes every 60s during market hours
    const interval = setInterval(() => {
      const hour = new Date().getUTCHours();
      const isMarketHours = hour >= 13 && hour < 21; // 9:30am–5pm ET approx
      if (isMarketHours) void loadData();
    }, 60_000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleSync = async () => {
    setSyncing(true);
    setError(null);
    try {
      const result = await finance.syncPositions();
      setStatusMsg(`Synced ${result.positions} positions across ${result.accounts} accounts`);
      await loadData();
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  };

  const handleRefreshTargets = async () => {
    setRefreshingTgts(true);
    setError(null);
    try {
      const result = await finance.refreshTargets();
      setStatusMsg(`Generated ${result.generated} price targets`);
      await loadData();
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setRefreshingTgts(false);
    }
  };

  if (loading) return <div className="loading">loading portfolio…</div>;

  return (
    <div>
      {/* ── Header ── */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
        <div>
          <div className="page-title">Finance Dashboard</div>
          <div className="page-subtitle">
            Schwab portfolio · real-time positions · AI price targets
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
          <button
            className="btn"
            onClick={() => void handleSync()}
            disabled={syncing}
            style={{ fontSize: 12 }}
          >
            {syncing ? "Syncing…" : "⟳ Sync Positions"}
          </button>
          <button
            className="btn"
            onClick={() => void handleRefreshTargets()}
            disabled={refreshingTgts}
            style={{ fontSize: 12 }}
          >
            {refreshingTgts ? "Analyzing…" : "◎ Refresh Targets"}
          </button>
        </div>
      </div>

      {syncedAt && (
        <div style={{ color: "var(--fg-muted)", fontSize: 12, marginBottom: 16 }}>
          Last synced: {new Date(syncedAt).toLocaleString("en-US", { timeZone: "America/New_York" })} ET
          {Object.keys(quotes).length > 0 && (
            <span style={{ marginLeft: 12 }}>· Quotes live</span>
          )}
        </div>
      )}

      {error && (
        <div className="card" style={{ borderColor: "var(--red)", marginBottom: 16 }}>
          <span style={{ color: "var(--red)" }}>⚠ {error}</span>
        </div>
      )}

      {statusMsg && (
        <div className="card" style={{ borderColor: "var(--green)", marginBottom: 16 }}>
          <span style={{ color: "var(--green)" }}>✓ {statusMsg}</span>
        </div>
      )}

      {/* ── Totals bar ── */}
      {totals && <TotalsBar totals={totals} />}

      {/* ── No data state ── */}
      {accounts.length === 0 ? (
        <div className="card">
          <div className="empty">
            No positions found. Click <strong>Sync Positions</strong> to pull from Schwab.
          </div>
        </div>
      ) : (
        accounts.map((acct) => (
          <AccountCard
            key={acct.account_number}
            account={acct}
            positions={positions}
            quotes={quotes}
            targets={targets}
          />
        ))
      )}

      {/* ── Price Targets table ── */}
      {Object.keys(targets).length > 0 && (
        <div className="card" style={{ marginTop: 8 }}>
          <div className="card-title">AI Price Targets — Watchlist</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Trend</th>
                  <th>Current</th>
                  <th>Daily Target</th>
                  <th>Weekly Target</th>
                  <th>Support</th>
                  <th>Resistance</th>
                  <th>Confidence</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {Object.values(targets).map((t) => {
                  const q = quotes[t.symbol];
                  return (
                    <tr key={t.symbol}>
                      <td><strong style={{ color: "var(--accent)" }}>{t.symbol}</strong></td>
                      <td>{trendIcon(t.trend)} {t.trend}</td>
                      <td>{q ? fmt$(q.last_price) : t.current_price ? fmt$(t.current_price) : "—"}</td>
                      <td style={{ color: "var(--accent)" }}>{fmt$(t.daily_target)}</td>
                      <td style={{ color: "var(--accent)" }}>{fmt$(t.weekly_target)}</td>
                      <td style={{ color: "var(--green)" }}>{fmt$(t.support)}</td>
                      <td style={{ color: "var(--red)" }}>{fmt$(t.resistance)}</td>
                      <td>
                        <span style={{
                          color: t.confidence >= 0.7 ? "var(--green)" : t.confidence >= 0.4 ? "var(--yellow)" : "var(--red)"
                        }}>
                          {Math.round(t.confidence * 100)}%
                        </span>
                      </td>
                      <td style={{ color: "var(--fg-muted)", fontSize: 11 }}>
                        {new Date(t.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
