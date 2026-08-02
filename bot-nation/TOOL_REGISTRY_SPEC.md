# Tool Registry Spec (current state)

The `tools` D1 table as it exists after migrations 0001–0045. **13 rows** — this is the
complete, verified registry (derived by applying all migrations and reading the table).
Registration lives in `migrations/{0006,0033,0035,0041,0045}_*.sql`.

**Status semantics** (the `status` column): `active` = callable / **LIVE**; `pending_review`
= registered but **EXPERIMENTAL / approval-gated**, not for autonomous use.

**Table shape:** `id, name, kind, status, description, endpoint, schema (JSON Schema), installed_by_agent_id, approval_id, created_at, updated_at`.

---

## System / test

### `echo` — LIVE (`http_api`)
- Endpoint: `https://httpbin.org/post`
- Input: `{ "message": string }` (required: `message`)

### `self_ping` — LIVE (`http_api`)
- Endpoint: `…workers.dev/health`
- Input: `{}` (none)

## Research / intel

### `web_search` — LIVE (`searxng`)
- Endpoint (registered): `https://searxng-placeholder.up.railway.app` — **placeholder**; the live
  SearXNG instance is configured via the `SEARXNG_BASE_URL` var, not this row.
- Input: `{ "query": string, "count"?: integer(≤10, default 5) }` (required: `query`)

### `github_repo_info` — LIVE (`http_get`)
- Endpoint: `https://api.github.com/repos`
- Input: `{ "owner": string, "repo": string }` (required: both)

### `ossinsight_repo` — LIVE (`http_get`)
- Endpoint: `https://api.ossinsight.io/v1/repos`
- Input: `{ "owner": string, "repo": string }` (required: both)

## Build / self-modification (operator-review gated at the endpoint)

### `read_github_file` — LIVE (`http_api`)
- Endpoint: `…workers.dev/api/build/read-file`
- Input: `{ "path": string }` (required: `path`)

### `edit_file_section` — LIVE (`http_api`)
- Endpoint: `…workers.dev/api/build/edit-section`
- Input: `{ "path", "old_string", "new_string", "commit_message", "change_summary" }` (all required).
  Surgical single-section edit; `old_string` must match verbatim and be unique.

### `submit_code_change` — LIVE (`http_api`)
- Endpoint: `…workers.dev/api/build/submit`
- Input: `{ "files": [{ "path", "content" }], "commit_message", "change_summary" }` (all required).
  Full-file writes; routed through operator ✅/❌ review before deploy.

## Finance

### `schwab_positions` — LIVE (`http_api`)
- Endpoint: `…workers.dev/api/finance/positions`
- Input: `{}` (none). Returns current D1-stored Schwab positions.

## projecT87 (DeFi / Arbitrum) — registered in 0045

### `p87_vault_health` — LIVE (`http_api`)
- Endpoint: `…workers.dev/api/p87/vault/health`
- Input: `{}`. Returns `health_factor, total_collateral_usd, total_debt_usd, net_worth_usd, available_borrows_usd`. Read-only.

### `p87_notifications` — LIVE (`http_api`)
- Endpoint: `…workers.dev/api/p87/notifications`
- Input: `{}`. Read-only.

### `p87_health` — LIVE (`http_api`)
- Endpoint: `…workers.dev/api/p87/health`
- Input: `{}`. Liveness. Read-only.

### `p87_credit_borrow` — ⚠️ EXPERIMENTAL · approval-gated (`http_api`, `status = pending_review`)
- Endpoint: `…workers.dev/api/p87/credit/borrow`
- Input: `{ "amount": number(>0, ≤10000), "asset": "DAI"|"USDC"|"USDT" }` (both required)
- On-chain borrow against Aave collateral. **NON-AUTONOMOUS**: the proxy records intent only and
  never executes on-chain (see `API_CONTRACTS.md` and `PROJECT87_INTEGRATION.md`). Do not enable for
  autonomous/unattended use.

---

## Notes / intentionally omitted

- **`schwab_options_chain`** — referenced by an `UPDATE` in `migrations/0033` but **no such row exists**
  in the registry (the UPDATE matched 0 rows; the tool was never `INSERT`ed). Not documented as a tool.
- Endpoints shown as `…workers.dev` are `https://bot-nation-api.thejamalshackleford.workers.dev`.
- All read-only projecT87 tools return `503 NOT WIRED` until `PROJECT87_API_URL` + `PROJECT87_API_KEY` are set.
