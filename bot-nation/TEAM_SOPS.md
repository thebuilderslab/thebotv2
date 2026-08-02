# Team SOPs (current state)

Operating procedures for the teams **as wired today**, derived from `packages/backend-api/src`
(`scheduled.ts`, `services/*`, `routes/*`) + `wrangler.jsonc` crons. Only what exists is documented;
idle/unwired paths are labeled.

**Reality check:** of the staffed teams, **only Finance runs autonomously** — its crons are the only
active schedules. Bailey has full pipeline code but its crons are **PAUSED**. Agency and P87 are
staffed but their automation is **NOT WIRED**.

---

## Finance — ✅ ACTIVE (autonomous)

**Team:** `team-finance` — `agent-finance-lead`, `agent-finance-analyst`.
**Tools:** `schwab_positions` (registry) + `/api/finance/*`, `/api/schwab/*`, `/api/tws/*` routes.
**External:** Schwab API (OAuth), thinkorswim webhook, TradingAgents consensus (`TRADING_URL`).

**Daily state machine (cron-driven, `scheduled.ts` + `MISSION_CRONS`, ET, Mon–Fri):**
1. `*/5 * * * *` — **task dispatcher** (engine; routes pending tasks → AgentActor DO).
2. `0 */6 * * *` — **Schwab token heartbeat** (+ re-auth alert on failure).
3. `*/5 13-20 * * 1-5` — **market-hours position stream** (TWS ticks; flags stale ticks).
4. `30 12` — **morning trading brief** → task for `agent-finance-lead`.
5. `30 13` — **daily price targets** (`generatePriceTargets` → Telegram).
6. `30 18` — **midday trading analysis**.
7. `30 20` — **EOD trading wrap-up**.
8. `35 20` — **trade-decision quality metrics** (programmatic).
9. `0 12` — **daily finance-intel progress report** (feature-flag gated).
10. `0 13 * * 1` — **OpenRouter weekly balance report**.

**Dead crons (configured, no handler — no-op):** `0 19 * * 1-5` (position exit monitor),
`0 0 * * 1` (weekly trade planning). Documented as **NOT WIRED**.

---

## Bailey Group (real estate) — 🟡 pipeline code LIVE, crons PAUSED

**Team:** `team-bailey` (staffed: lead, propstream, scorer, voice, crm, observability).
**Tools/routes:** `/api/bailey/*`, `/api/propstream/*`, `/api/retell/*` (all LIVE endpoints).
**Autonomous schedule:** **none active** (Bailey crons are in the PAUSED block).

**Pipeline state machine (code exists; invoked via routes / manual, not by cron):**
1. **Ingest** — PropStream CSV → `propstream-transformer.ts` (`POST /api/propstream/import-csv`)
   or `/api/bailey/search-and-ingest`.
2. **Score** — `bailey-scorer.ts` (Claude Haiku), 0–12 rubric:
   `distress 0–4 + equity 0–3 + ownership 0–3 + market 0–2` → `{ score, disposition, reasoning, call_angle, script_variables, confidence }`.
3. **Route by disposition** (`getNextTaskKind`): `hot (≥8)` → `seller_outbound_call`;
   `warm (4–7)` → `seller_outbound_call` (testing phase); `cold (<4)` → archive (null).
4. **Voice call** — `retell-voice-queue.ts` → Retell `create-phone-call` as **"Naomi/Niamo"**
   (Bailey Group acquisitions persona); skips DNC/attempted numbers; dynamic script vars from the score.
5. **CRM / handoff** — call-complete webhook (`/api/retell/call-complete`) → transcript, tour scheduling, rep notify.

---

## Agency (sales) — ⚪ staffed, automation NOT WIRED

**Team:** `team-agency` (growthops, pipelineops, revops, guardrail, observability personas).
**Assets:** owns the web properties in `bot-nation/sites/` — **`yope-consultancy`** and
**`synergy-landing`** — tracked in the `agency_sites` / `agency_deploys` D1 tables.
**YOPE** is an Agency web property (a consultancy site), **not** its own team and **not** a compliance
SOP — no agent-platform YOPE procedure exists in code.
**Status:** no active crons, no wired task flow. **NOT WIRED** for autonomous operation.

---

## Project 87 (DeFi / Arbitrum) — 🟡 read-only tools LIVE, execution EXPERIMENTAL/NOT WIRED

**Team:** `team-p87` (planner, risk, nurse + more personas in `knowledge-base.ts`).
**Service:** native `bot-nation/projecT87/` (FastAPI + Web3), reached via `PROJECT87_API_URL`
(**503 / NOT WIRED** until URL + `PROJECT87_API_KEY` set). See `PROJECT87_INTEGRATION.md`.

**Wired today (Phase 2):**
- Read-only tools/routes: `p87_vault_health`, `p87_notifications`, `p87_health` (LIVE when configured).
- Console **DeFi / P87** page (`/defi`) shows health-factor / collateral / debt / notifications.

**projecT87 operating loop (in the service; the on-chain path is NOT driven autonomously by bot-nation):**
delegate via EIP-712 → borrow on Aave collateral → swap / debt-swap growth + short-hedge strategies →
health-factor monitor (<1.5 alert) → notifications.

**Gated / not wired:**
- `p87_credit_borrow` / `POST /api/p87/credit/borrow` — **EXPERIMENTAL, approval-gated, non-autonomous**
  (records intent only; never executes on-chain).
- `defi_*` task-kinds (`AgentActor.ts` timeout stubs) → projecT87 **autonomous dispatch: NOT WIRED**.
- Borrow execution-after-approval: **NOT WIRED**.
- projecT87's bundled real-estate module (`real_estate_tasks.py`): **NOT WIRED** to bot-nation.
