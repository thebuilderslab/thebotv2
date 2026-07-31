# projecT87 Integration (Phase 2)

How the vendored native DeFi service `bot-nation/projecT87/` connects to `bot-nation-api`
and the console. Grounded in the actual wiring committed in Phase 2.

## Environment

| Var | Where | Purpose |
|---|---|---|
| `PROJECT87_API_URL` | `wrangler.jsonc` var (plaintext) | base URL of the deployed projecT87 service. **Empty = NOT WIRED.** |
| `PROJECT87_API_KEY` | secret (`wrangler secret put PROJECT87_API_KEY`) | sent as `X-API-Key`; projecT87 maps it to a wallet. |

Both are declared on the `Env` interface in `src/index.ts`. When either is unset, the read-only
routes return `503 { error: "projecT87 NOT WIRED" }` and the console shows a NOT WIRED banner.

## Backend (bot-nation-api)

- **Client:** `src/services/projecT87-client.ts` — typed calls mirroring `api_server.py` Pydantic models
  (`P87VaultHealth`, `P87Notification`, `P87BorrowRequest/Response`). Sends `X-API-Key`.
- **Routes:** `src/routes/projecT87.ts`, mounted at `/api/p87/*` (Hono native + legacy dispatch in `index.ts`):

| Route | Backing | Status |
|---|---|---|
| `GET /api/p87/status` | local | ✅ live (reports configured + endpoint lists) |
| `GET /api/p87/health` | `p87Health` | ✅ **WIRED** (read-only) |
| `GET /api/p87/vault/health` | `p87VaultHealth` | ✅ **WIRED** (read-only) |
| `GET /api/p87/notifications` | `p87Notifications` | ✅ **WIRED** (read-only) |
| `POST /api/p87/credit/borrow` | records intent only | ⚠️ **EXPERIMENTAL · APPROVAL-GATED · NON-AUTONOMOUS** |

### Borrow safety

`POST /api/p87/credit/borrow` **does not execute on-chain**. It validates input
(`amount` >0 ≤10000, `asset` ∈ DAI/USDC/USDT), writes a `p87.borrow_requested` event
(`executed: false`), and returns `202 { status: "pending_approval", executed: false }`.
The client's `p87Borrow()` executor exists but is **called by nothing** — reserved for a future
explicitly-approved, attended flow. It is **never** wired to a cron, task-kind, or autonomous path.

## Tool registry

Migration `migrations/0045_projecT87_tools.sql` registers:
- `p87_vault_health`, `p87_notifications`, `p87_health` → `status = active`
- `p87_credit_borrow` → `status = pending_review` (EXPERIMENTAL; approval-gated)

Endpoints point at the bot-nation-api proxy (`/api/p87/*`), not projecT87 directly.

## Console (single control-plane UI)

Merged into the existing console — **no separate dashboard app**:
- `packages/frontend-app/src/api/client.ts` — `p87` client (`status`, `vaultHealth`, `notifications`, `requestBorrow`).
- `packages/frontend-app/src/pages/DefiDashboard.tsx` — new **DeFi / P87** page: health-factor + collateral/debt/
  net-worth/available-borrow stat cards, notifications list, and a borrow panel flagged
  *EXPERIMENTAL · APPROVAL-GATED · NON-AUTONOMOUS* that calls the gated endpoint (records intent only).
- `packages/frontend-app/src/App.tsx` — nav entry `DeFi / P87` (`/defi`) + route.

The projecT87 standalone dashboard files (`web_dashboard.py`, `templates/`, `static/`) were used only as
reference and can be removed from the vendored tree now that the views live in the console.

## Status summary

- **WIRED (live when configured):** `p87/health`, `p87/vault/health`, `p87/notifications`; console DeFi page.
- **GATED (experimental):** `p87/credit/borrow` — records intent only; on-chain execution NOT WIRED.
- **NOT WIRED:** actual borrow execution-after-approval; `defi_*` task-kind → projecT87 autonomous dispatch
  (intentionally left for a controlled later step); projecT87's unrelated real-estate module.
- **Prerequisite:** deploy the projecT87 Python service and set `PROJECT87_API_URL` + `PROJECT87_API_KEY`.
