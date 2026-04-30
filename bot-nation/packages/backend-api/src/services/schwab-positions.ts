/**
 * Schwab Positions + Quotes Service
 *
 * Fetches live account positions and market quotes from the Schwab API,
 * persists them to D1, and provides typed read access for routes and agents.
 *
 * Endpoints used:
 *   GET https://api.schwabapi.com/trader/v1/accounts?fields=positions
 *   GET https://api.schwabapi.com/marketdata/v1/quotes?symbols=A,B,C
 */

import { run, query, queryOne } from "../db/schema";
import { getAccessToken } from "./schwab-auth";

const TRADER_BASE = "https://api.schwabapi.com/trader/v1";
const MARKET_BASE = "https://api.schwabapi.com/marketdata/v1";

// Map last-4 account digits → human label
const ACCOUNT_LABELS: Record<string, string> = {
  "749": "Individual",
  "105": "Roth IRA",
  "266": "Joint Tenant",
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SchwabPosition {
  account_number: string;
  account_label:  string;
  account_type:   string;
  symbol:         string;
  asset_type:     string;
  description:    string;
  quantity:       number;
  average_price:  number;
  market_value:   number;
  cost_basis:     number;
  unrealized_pnl: number;
  current_day_pnl: number;
  current_day_pnl_pct: number;
  synced_at:      string;
}

export interface SchwabAccountSummary {
  account_number:    string;
  account_label:     string;
  account_type:      string;
  liquidation_value: number;
  cash_balance:      number;
  day_pnl:           number;
  synced_at:         string;
}

export interface SchwabQuote {
  symbol:        string;
  last_price:    number;
  bid_price:     number;
  ask_price:     number;
  change_amount: number;
  change_pct:    number;
  volume:        number;
  quote_time:    string;
}

// ── Raw Schwab API shapes ─────────────────────────────────────────────────────

interface SchwabInstrument {
  assetType?:   string;
  cusip?:       string;
  symbol?:      string;
  description?: string;
}

interface SchwabPositionRaw {
  longQuantity?:                   number;
  shortQuantity?:                  number;
  averagePrice?:                   number;
  currentDayProfitLoss?:           number;
  currentDayProfitLossPercentage?: number;
  marketValue?:                    number;
  instrument?:                     SchwabInstrument;
}

interface SchwabAccountRaw {
  securitiesAccount: {
    accountNumber: string;
    type:          string;
    positions?:    SchwabPositionRaw[];
    currentBalances?: {
      liquidationValue?: number;
      cashBalance?:      number;
      currentDayProfitLoss?: number;
    };
  };
}

interface SchwabQuoteRaw {
  quote?: {
    lastPrice?:         number;
    bidPrice?:          number;
    askPrice?:          number;
    netChange?:         number;
    netPercentChange?:  number;
    totalVolume?:       number;
    quoteTimeInLong?:   number;
  };
}

// ── Fetch + store positions ───────────────────────────────────────────────────

export async function syncPositions(
  db: D1Database,
  clientId: string,
  clientSecret: string,
): Promise<{ positions: SchwabPosition[]; accounts: SchwabAccountSummary[] }> {
  const token = await getAccessToken(db, clientId, clientSecret);
  const now   = new Date().toISOString();

  const resp = await fetch(`${TRADER_BASE}/accounts?fields=positions`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept":        "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Schwab accounts API ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = await resp.json() as SchwabAccountRaw[];

  const positions:  SchwabPosition[]       = [];
  const accounts:   SchwabAccountSummary[] = [];

  for (const acct of data) {
    const sec   = acct.securitiesAccount;
    const last4 = sec.accountNumber.slice(-4);
    const label = ACCOUNT_LABELS[last4] ?? `Account ...${last4}`;

    // ── Account summary ──────────────────────────────────────────────────────
    const summary: SchwabAccountSummary = {
      account_number:    last4,
      account_label:     label,
      account_type:      sec.type,
      liquidation_value: sec.currentBalances?.liquidationValue ?? 0,
      cash_balance:      sec.currentBalances?.cashBalance      ?? 0,
      day_pnl:           sec.currentBalances?.currentDayProfitLoss ?? 0,
      synced_at:         now,
    };
    accounts.push(summary);

    await run(db, `
      INSERT INTO schwab_account_summary
        (id, account_number, account_type, account_label, liquidation_value, cash_balance, day_pnl, synced_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account_number) DO UPDATE SET
        account_type      = excluded.account_type,
        account_label     = excluded.account_label,
        liquidation_value = excluded.liquidation_value,
        cash_balance      = excluded.cash_balance,
        day_pnl           = excluded.day_pnl,
        synced_at         = excluded.synced_at,
        updated_at        = excluded.updated_at
    `, [crypto.randomUUID(), last4, sec.type, label,
        summary.liquidation_value, summary.cash_balance, summary.day_pnl, now, now]);

    // ── Positions ────────────────────────────────────────────────────────────
    // Replace all positions for this account on each sync
    await run(db, `DELETE FROM schwab_positions WHERE account_number = ?`, [last4]);

    for (const raw of (sec.positions ?? [])) {
      const symbol   = raw.instrument?.symbol ?? "UNKNOWN";
      const qty      = (raw.longQuantity ?? 0) - (raw.shortQuantity ?? 0);
      const costBasis = qty * (raw.averagePrice ?? 0);
      const unrealizedPnl = (raw.marketValue ?? 0) - costBasis;

      const pos: SchwabPosition = {
        account_number:      last4,
        account_label:       label,
        account_type:        sec.type,
        symbol,
        asset_type:          raw.instrument?.assetType  ?? "EQUITY",
        description:         raw.instrument?.description ?? symbol,
        quantity:            qty,
        average_price:       raw.averagePrice                      ?? 0,
        market_value:        raw.marketValue                       ?? 0,
        cost_basis:          costBasis,
        unrealized_pnl:      unrealizedPnl,
        current_day_pnl:     raw.currentDayProfitLoss              ?? 0,
        current_day_pnl_pct: raw.currentDayProfitLossPercentage    ?? 0,
        synced_at:           now,
      };
      positions.push(pos);

      await run(db, `
        INSERT INTO schwab_positions
          (id, account_number, account_type, account_label, symbol, asset_type, description,
           quantity, average_price, market_value, cost_basis, unrealized_pnl,
           current_day_pnl, current_day_pnl_pct, synced_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [crypto.randomUUID(), last4, sec.type, label, symbol,
          pos.asset_type, pos.description, qty,
          pos.average_price, pos.market_value, pos.cost_basis,
          pos.unrealized_pnl, pos.current_day_pnl, pos.current_day_pnl_pct,
          now, now, now]);
    }
  }

  return { positions, accounts };
}

// ── Read stored positions ─────────────────────────────────────────────────────

export async function getStoredPositions(db: D1Database): Promise<{
  positions:  SchwabPosition[];
  accounts:   SchwabAccountSummary[];
  synced_at:  string | null;
}> {
  const [positions, accounts] = await Promise.all([
    query<SchwabPosition>(db, `
      SELECT * FROM schwab_positions ORDER BY account_number, market_value DESC
    `, []),
    query<SchwabAccountSummary>(db, `
      SELECT * FROM schwab_account_summary ORDER BY account_number
    `, []),
  ]);

  const synced_at = positions[0]?.synced_at ?? null;
  return { positions, accounts, synced_at };
}

// ── Fetch real-time quotes ────────────────────────────────────────────────────

export async function fetchQuotes(
  db: D1Database,
  clientId: string,
  clientSecret: string,
  symbols: string[],
): Promise<SchwabQuote[]> {
  if (symbols.length === 0) return [];

  const token = await getAccessToken(db, clientId, clientSecret);
  const symbolStr = [...new Set(symbols)].join(",");

  const resp = await fetch(
    `${MARKET_BASE}/quotes?symbols=${encodeURIComponent(symbolStr)}&fields=quote`,
    {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept":        "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Schwab quotes API ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = await resp.json() as Record<string, SchwabQuoteRaw>;

  return Object.entries(data).map(([symbol, raw]) => ({
    symbol,
    last_price:    raw.quote?.lastPrice        ?? 0,
    bid_price:     raw.quote?.bidPrice         ?? 0,
    ask_price:     raw.quote?.askPrice         ?? 0,
    change_amount: raw.quote?.netChange        ?? 0,
    change_pct:    raw.quote?.netPercentChange ?? 0,
    volume:        raw.quote?.totalVolume      ?? 0,
    quote_time:    raw.quote?.quoteTimeInLong
      ? new Date(raw.quote.quoteTimeInLong).toISOString()
      : new Date().toISOString(),
  }));
}

// ── Portfolio totals helper ───────────────────────────────────────────────────

export function calcPortfolioTotals(
  accounts: SchwabAccountSummary[],
  positions: SchwabPosition[],
): {
  total_value:     number;
  total_cash:      number;
  total_invested:  number;
  total_day_pnl:   number;
  total_unrealized_pnl: number;
} {
  const total_value    = accounts.reduce((s, a) => s + a.liquidation_value, 0);
  const total_cash     = accounts.reduce((s, a) => s + a.cash_balance, 0);
  const total_invested = positions.reduce((s, p) => s + p.market_value, 0);
  const total_day_pnl  = positions.reduce((s, p) => s + p.current_day_pnl, 0);
  const total_unrealized_pnl = positions.reduce((s, p) => s + p.unrealized_pnl, 0);

  return { total_value, total_cash, total_invested, total_day_pnl, total_unrealized_pnl };
}

// ── Format positions for Telegram ────────────────────────────────────────────

export function formatPositionsForTelegram(
  accounts: SchwabAccountSummary[],
  positions: SchwabPosition[],
  quotes: SchwabQuote[] = [],
): string {
  const totals  = calcPortfolioTotals(accounts, positions);
  const quoteMap = Object.fromEntries(quotes.map((q) => [q.symbol, q]));

  const totalDaySign  = totals.total_day_pnl  >= 0 ? "+" : "";
  const totalUnrSign  = totals.total_unrealized_pnl >= 0 ? "+" : "";

  let msg = `📊 *Portfolio Snapshot*\n\n`;
  msg += `💼 Total Value: *$${totals.total_value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}*\n`;
  msg += `📈 Day P&L: *${totalDaySign}$${totals.total_day_pnl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}*\n`;
  msg += `📉 Unrealized: *${totalUnrSign}$${totals.total_unrealized_pnl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}*\n\n`;

  // Group by account
  for (const acct of accounts) {
    const acctPositions = positions.filter((p) => p.account_number === acct.account_number);
    if (acctPositions.length === 0) continue;

    const acctSign = acct.day_pnl >= 0 ? "+" : "";
    msg += `*${acct.account_label} (...${acct.account_number})*\n`;
    msg += `Value: $${acct.liquidation_value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Day: ${acctSign}$${acct.day_pnl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n\n`;

    for (const pos of acctPositions) {
      const q         = quoteMap[pos.symbol];
      const daySign   = pos.current_day_pnl >= 0 ? "▲" : "▼";
      const unrealSign = pos.unrealized_pnl >= 0 ? "+" : "";
      const currentPx  = q ? `$${q.last_price.toFixed(2)} (${q.change_pct >= 0 ? "+" : ""}${q.change_pct.toFixed(2)}%)` : `avg $${pos.average_price.toFixed(2)}`;

      msg += `  ${daySign} *${pos.symbol}* × ${pos.quantity} @ ${currentPx}\n`;
      msg += `    MV: $${pos.market_value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} · Unreal: ${unrealSign}$${pos.unrealized_pnl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n`;
    }
    msg += "\n";
  }

  msg += `_Synced ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET_`;
  return msg;
}

// ── Options chain ─────────────────────────────────────────────────────────────

export interface OptionContract {
  symbol:           string;
  strike:           number;
  expiration:       string;
  contract_type:    "CALL" | "PUT";
  bid:              number;
  ask:              number;
  mark:             number;
  last:             number;
  delta:            number;
  gamma:            number;
  theta:            number;
  vega:             number;
  iv:               number;  // implied volatility
  volume:           number;
  open_interest:    number;
  dte:              number;  // days to expiration
  in_the_money:     boolean;
}

export interface OptionsChainResult {
  symbol:           string;
  underlying_price: number;
  as_of:            string;
  calls:            OptionContract[];
  puts:             OptionContract[];
}

interface SchwabOptionLeg {
  putCall?:              string;
  symbol?:               string;
  description?:          string;
  bid?:                  number;
  ask?:                  number;
  mark?:                 number;
  last?:                 number;
  delta?:                number;
  gamma?:                number;
  theta?:                number;
  vega?:                 number;
  volatility?:           number;
  totalVolume?:          number;
  openInterest?:         number;
  strikePrice?:          number;
  daysToExpiration?:     number;
  inTheMoney?:           boolean;
  expirationDate?:       string;
}

export async function fetchOptionsChain(
  db: D1Database,
  clientId: string,
  clientSecret: string,
  symbol: string,
  opts: {
    contractType?: "CALL" | "PUT" | "ALL";
    strikeCount?:  number;        // strikes near ATM (default 10 per side)
    fromDate?:     string;        // YYYY-MM-DD
    toDate?:       string;        // YYYY-MM-DD
  } = {},
): Promise<OptionsChainResult> {
  const token = await getAccessToken(db, clientId, clientSecret);

  const params = new URLSearchParams({
    symbol:                symbol.toUpperCase(),
    contractType:          opts.contractType ?? "ALL",
    strikeCount:           String(opts.strikeCount ?? 10),
    includeUnderlyingQuote: "true",
    strategy:              "SINGLE",
  });
  if (opts.fromDate) params.set("fromDate", opts.fromDate);
  if (opts.toDate)   params.set("toDate",   opts.toDate);

  const resp = await fetch(`${MARKET_BASE}/chains?${params.toString()}`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept":        "application/json",
    },
    signal: AbortSignal.timeout(12_000),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Schwab options chain ${resp.status}: ${body.slice(0, 300)}`);
  }

  const data = await resp.json() as {
    symbol?:          string;
    underlyingPrice?: number;
    callExpDateMap?:  Record<string, Record<string, SchwabOptionLeg[]>>;
    putExpDateMap?:   Record<string, Record<string, SchwabOptionLeg[]>>;
  };

  const underlyingPrice = data.underlyingPrice ?? 0;
  const calls: OptionContract[] = [];
  const puts:  OptionContract[] = [];

  const parseLegs = (
    expDateMap: Record<string, Record<string, SchwabOptionLeg[]>> | undefined,
    contractType: "CALL" | "PUT",
    out: OptionContract[],
  ) => {
    if (!expDateMap) return;
    for (const [expKey, strikeMap] of Object.entries(expDateMap)) {
      // expKey looks like "2025-04-25:4"
      const expDate = expKey.split(":")[0] ?? expKey;
      for (const legs of Object.values(strikeMap)) {
        for (const leg of legs) {
          const dte = leg.daysToExpiration ?? 0;
          out.push({
            symbol:        leg.symbol         ?? "",
            strike:        leg.strikePrice    ?? 0,
            expiration:    expDate,
            contract_type: contractType,
            bid:           leg.bid            ?? 0,
            ask:           leg.ask            ?? 0,
            mark:          leg.mark           ?? 0,
            last:          leg.last           ?? 0,
            delta:         leg.delta          ?? 0,
            gamma:         leg.gamma          ?? 0,
            theta:         leg.theta          ?? 0,
            vega:          leg.vega           ?? 0,
            iv:            leg.volatility     ?? 0,
            volume:        leg.totalVolume    ?? 0,
            open_interest: leg.openInterest   ?? 0,
            dte,
            in_the_money:  leg.inTheMoney     ?? false,
          });
        }
      }
    }
  };

  parseLegs(data.callExpDateMap, "CALL", calls);
  parseLegs(data.putExpDateMap,  "PUT",  puts);

  // Sort by expiration then strike
  const sortLegs = (a: OptionContract, b: OptionContract) =>
    a.expiration.localeCompare(b.expiration) || a.strike - b.strike;

  calls.sort(sortLegs);
  puts.sort(sortLegs);

  return {
    symbol:           symbol.toUpperCase(),
    underlying_price: underlyingPrice,
    as_of:            new Date().toISOString(),
    calls,
    puts,
  };
}
