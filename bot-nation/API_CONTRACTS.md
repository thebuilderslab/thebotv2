# API Contracts — bot-nation-api (current state)

Routes of the live Cloudflare Worker `bot-nation-api` (`packages/backend-api/src`). Hono v4 entry
`src/index.ts`. **Architecture:** hybrid router — some routers are Hono-native (`telegram`, `tws`,
`schwab`, `build`, `admin`, `projecT87`), the rest are itty-routers dispatched by a single
`app.all("/api/*")` catch-all. **No app-level auth or rate-limit middleware.** **No pagination** —
lists are unbounded (`ORDER BY created_at DESC`) or hard-`LIMIT`ed. `/debug/env` is unauthenticated.

Labels: **LIVE** = implemented & reachable · **EXPERIMENTAL** = implemented but gated · **NOT WIRED** = configured route with no working backend yet.

## Route table

| Method + Path | Purpose | Status |
|---|---|---|
| `GET /health` | liveness → `{status:"ok"}` | LIVE |
| `GET /` | service banner | LIVE |
| `GET /debug/env` | secret-presence probe (unauthenticated) | LIVE |
| `GET /api/stats` | table row counts | LIVE |
| `GET /api/graph` | node/edge workspace graph | LIVE |
| `GET/POST/PATCH /api/tasks…` | task CRUD + assign/status/cancel | LIVE |
| `GET/POST/PATCH /api/agents…` | agents + notes | LIVE |
| `GET/POST /api/teams…` | teams | LIVE |
| `GET/POST /api/approvals…` | approvals + inbox + decision | LIVE |
| `GET/POST/PATCH /api/proposals…` | proposals + submit | LIVE |
| `GET /api/events…` | event log (`LIMIT 200`) | LIVE |
| `GET/POST/DELETE /api/artifacts…` | artifacts | LIVE |
| `GET/POST/PATCH /api/tools…` | tool registry | LIVE |
| `GET/POST/PATCH/DELETE /api/graphs…` | agent graphs | LIVE |
| `GET/POST /api/actors/:id…` | Durable Object connect/dispatch/session | LIVE |
| `GET /api/nation/…` | map / room-status / dept-summary | LIVE |
| `POST /api/supervisor/reminders/…` | supervisor reminders | LIVE |
| `POST /api/intake` | intake | LIVE |
| `POST /api/telegram/webhook` (+ debug) | Telegram entry | LIVE |
| `POST/GET /api/tws/…` | thinkorswim register/tick/alert/positions/signals/portfolio | LIVE |
| `GET/POST /api/finance/…` | targets/positions/quotes/orders(stage/execute)/thresholds | LIVE |
| `GET /api/schwab/{auth,callback,status}` · `POST /refresh` | Schwab OAuth | LIVE |
| `POST/GET /api/build/…` | self-mod submit/edit-section/read-file/change | LIVE |
| `POST /api/bailey/…` · `/api/propstream/…` · `/api/retell/…` | real-estate pipeline (see TEAM_SOPS) | LIVE (crons PAUSED) |
| `POST /api/admin/replay-task-output` | admin util | LIVE |
| `GET /api/p87/status` | projecT87 integration status | LIVE |
| `GET /api/p87/health` · `/vault/health` · `/notifications` | projecT87 read-only proxy | LIVE¹ |
| `POST /api/p87/credit/borrow` | projecT87 borrow | **EXPERIMENTAL²** |

¹ Returns `503 { error:"projecT87 NOT WIRED" }` until `PROJECT87_API_URL` + `PROJECT87_API_KEY` are set.
² Records intent only; **never executes on-chain**; non-autonomous.

## Core request/response shapes (verified from source)

### `POST /api/tasks` → `201`
```jsonc
// request
{ "kind": string, "input": { "summary": string, "details"?: string },
  "createdByAgentId"?: string, "assignedAgentId"?: string,
  "preferredTeamId"?: string, "scheduled_for"?: string }
// response 201
{ "id": string, "status": "pending", "assignedAgentId": string|null,
  "teamId": string|null, "scheduled_for": string|null }
// 400 if kind or input.summary missing
```

### `GET /api/tasks/:id/output`
```jsonc
{ "taskId": string, "status": string, "output": object|string, "artifacts": Artifact[] }
```

### `GET /api/tws/signals?symbol=`
```jsonc
{ "signals": TwsSignal[] }   // latest 20, optionally filtered by symbol
```

### `GET /health` → `{ "status": "ok" }`
### `GET /api/stats`
```jsonc
{ "agents": int, "teams": int, "tasks": int, "proposals": int, "approvals": int,
  "events": int, "artifacts": int, "tools": int, "notes": int }
```

### `POST /api/telegram/webhook`
Accepts a Telegram `Update`; always returns `{ "ok": true }` immediately (work runs in `waitUntil`).
Sender is dropped unless `chatId === TELEGRAM_CHAT_ID`. Classifier: `simple | infrastructure | action`.

## projecT87 shapes (schemas mirror `projecT87/api_server.py` Pydantic models)

### `GET /api/p87/status` → LIVE
```jsonc
{ "configured": boolean, "wired_endpoints": string[], "gated_endpoints": string[] }
```
### `GET /api/p87/vault/health` → `P87VaultHealth`
```jsonc
{ "wallet_address": string, "health_factor": number, "total_collateral_usd": number,
  "total_debt_usd": number, "net_worth_usd": number, "available_borrows_usd": number }
```
### `GET /api/p87/notifications`
```jsonc
{ "notifications": [ { "id": number, "title": string, "message": string,
  "priority": string, "created_at": string } ] }
```
### `POST /api/p87/credit/borrow` → `202` (EXPERIMENTAL)
```jsonc
// request
{ "amount": number, "asset": "DAI"|"USDC"|"USDT" }   // amount >0, <=10000
// response 202 — intent recorded, NOT executed
{ "status": "pending_approval", "executed": false, "note": string,
  "request": { "amount": number, "asset": string }, "event_id": string }
// 422 on invalid amount/asset
```
