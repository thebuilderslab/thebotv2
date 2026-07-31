# projecT87 — DeFi Execution Service (native local service)

Multi-tenant autonomous DeFi service on **Arbitrum** (FastAPI + Web3). Users delegate via gasless
**EIP-712** signatures; the bot manages growth strategies and short hedges against **Aave V3** collateral,
non-custodially. Vendored into bot-nation from `github.com/thebuilderslab/projecT87` (de-git'd → native
local files). Runs as a **separate Python service** (deployed like the other Render services); bot-nation-api
reaches it over HTTP via `PROJECT87_API_URL` + `PROJECT87_API_KEY`.

> **Integration status: NOT WIRED.** As of vendoring, bot-nation-api does **not** call this service — there
> is no `PROJECT87_API_URL` binding and no client yet. The P87 team exists only as idle personas + `defi_*`
> task-kind stubs. Wiring is **Phase 2** (see repo plan). Do not treat P87 as live.

## API surface (`api_server.py`, all routes gated by `X-API-Key`)

| Method + path | Model | Maturity |
|---|---|---|
| `GET /api/v1/health` | — | ✅ Ready (liveness) |
| `GET /api/v1/vault/health` | `HealthResponse` | ✅ Ready (read-only Aave health factor) |
| `GET /api/v1/notifications` | `NotificationItem[]` | ✅ Ready (read-only) |
| `POST /api/v1/credit/borrow` | `BorrowRequest` → `BorrowResponse` | ⚠️ **EXPERIMENTAL** — on-chain write; heavy historical failure rate. Keep approval-gated; do **not** auto-execute. |

## Key modules

- `api_server.py` — FastAPI entrypoint (the tool surface for bot-nation).
- `aave_integration.py`, `aave_health_monitor.py` — Aave V3 positions + health-factor monitoring.
- `delegation_client.py`, `delegation_sig_processor.py` — EIP-712 gasless delegation.
- `debt_swap_profit_tracker.py`, `uniswap_integration.py`, `liability_short_strategy.py`,
  `market_signal_strategy.py`, `strategy_engine.py` — swap/debt-swap + strategy logic.
- `constants.py`, `config_constants.py`, `config.py`, `dm_abi.json`, `abi_cache/`, `contracts/` — chain
  addresses, ABIs, deployment artifacts.
- `web_dashboard.py` + `templates/` + `static/` — **reference only**; its DeFi views fold into the
  bot-nation console in Phase 2, after which these can be removed.
- `real_estate_tasks.py`, `searchiqs_scraper.py`, `google_client.py` — an unrelated real-estate module that
  ships in this repo; **NOT WIRED** to bot-nation.

## Run locally

```bash
cp .env.example .env      # fill in real values (never commit .env)
pip install -r requirements.txt
python api_server.py       # serves on $PORT (default 5000)
```

## Vendoring notes

- Pruned during vendoring (~638 files): runtime diagnostics/failure dumps, logs, backups, media, and
  redundant status docs. `.gitignore` blocks their return.
- **Security:** the vendored working tree is clean (no keys). The upstream GitHub repo has private-key
  material in its **git history** — rotate that wallet key and restrict the repo (advisory).
