# Bot Nation — Closure Audit (Phase 4)

Read-only closure audit of the streamline effort. **Verified facts** and **unresolved questions** are kept
separate. Branch: `chore/phase0-cleanup` (Phases 0–3 committed; not merged to `main`).

---

## 1. Current-state summary

**Complete (verified):**
- Phase 0 cleanup, Phase 1 projecT87 vendoring, Phase 2 wiring + `/defi` console merge, Phase 3 blueprint docs.
- **Finance runs autonomously today** — 12 active crons, Schwab OAuth/positions/orders/options, TWS stream, price targets, briefs. This is the usable core.
- bot-nation core API + console compile (frontend typechecks 0 errors).

**Partially complete:**
- **projecT87** — code wired; returns `503 NOT WIRED` until the Python service is deployed and `PROJECT87_API_URL`/`PROJECT87_API_KEY` are set.
- **Console `/defi`** — merged in source, not built/deployed.
- **Bailey** — full pipeline code reachable via routes; **no autonomous crons** (paused).

**Unresolved:**
- Moltbot/OpenClaw root scaffolding still on disk (verified dead, deletion deferred).
- projecT87 real-estate module ownership (ambiguous).
- Branch unmerged; some leftovers untracked.
- **Environment: C: drive is full** (476G/476G; a scratch clone was cleared to allow Phase-4 writes).

---

## 2. Four verification findings (Phase 4)

### 2.1 `searxng/` — ✅ LIVE infra (keep)
`searxng/` contains `Dockerfile`, `settings.yml`, `railway.toml` — the **deploy source** for a self-hosted
SearXNG service, consumed via `SEARXNG_BASE_URL = https://thebotv2-t0ik.onrender.com`. No own `.git`; not
imported by bot-nation code (only a dist sourcemap false-hit). **Verdict: live dependency's source — do not delete.**

### 2.2 Moltbot / OpenClaw root files — ✅ verified DEAD (deletion deferred)
`README.md` = "OpenClaw on Cloudflare Workers"; `start-openclaw.sh` launches the OpenClaw gateway;
`vitest.config.ts` targets `src/**` and `src/client/**` (the `src/` removed in Phase 0). No reference from the
bot-nation monorepo to the inner-root `package.json`/`tsconfig.json`. **Verdict: dead OpenClaw base.**
Files: `Dockerfile`, `index.html`, `vite.config.ts`, `vitest.config.ts`, `start-openclaw.sh`, `package.json`,
`tsconfig.json`, `AGENTS.md`, `CONTRIBUTING.md`, `README.md`. **Not deleted in P4** (deletion of root
scaffolding was explicitly deferred to follow-up) — see §6.

### 2.3 projecT87 real-estate module — ⚠️ UNRESOLVED (leave untouched)
`real_estate_tasks.py`, `searchiqs_scraper.py`, `google_client.py` are **imported by projecT87's own**
`run_autonomous_mainnet.py` (`from real_estate_tasks import check_and_run_scheduled_tasks`) and
`web_dashboard.py` — so they are **projecT87-internal**, not dead. They are **NOT** imported by `api_server.py`
(the only surface bot-nation calls), so they are **NOT wired to bot-nation**. SearchIQS = court/title records,
a different flow from Bailey's PropStream/skip-trace. **Verdict: ambiguous** — upstream projecT87 bundles a
real-estate sub-module into its runner. Options (delete / move→Bailey / keep as projecT87-internal) require an
ownership decision. **Not moved or deleted.** → follow-up §6.

### 2.4 Cron inventory — verified
**12 ACTIVE (all Finance/Schwab)** — see §5 / TEAM_SOPS. **9 in the paused block:** 8 are genuinely PAUSED
(handlers exist in `scheduled.ts`), **1 is DEAD** (`40 3 1 5 *` R16 one-time verification — 0 handler refs).
The 9 paused are **non-finance** crons (intel/research/skill/supervisor/youtube/quality/mission). None missing
from docs.

---

## 3. Cleanup / ownership table

| Item | Location | Owner | Status | Action | Notes |
|---|---|---|---|---|---|
| `wrangler.jsonc)`, `wrangler.jsonc.txt`, `{` | inner root | dead | **committed deletion (P4)** | done | Phase-0 junk tail |
| `schwab_options_chain` tool row | migrations | Finance | **fixed (P4, 0046)** | done | Was missing; capability was live |
| searxng/ | inner root | Infra | live (via URL) | keep | Deploy source for SEARXNG_BASE_URL |
| moltbot root (10 files) | inner root | legacy | **dead (verified)** | defer delete | §2.2; needs delete approval |
| projecT87 real-estate (3 py) | bot-nation/projecT87 | ambiguous | not wired to bot-nation | **defer** | §2.3; decision needed |
| `npx`,`notepad`,`type`,`test-time-parser*.js` | inner/bot-nation root | junk | on disk | defer | Stray; not in approved list |
| Your WIP edits + new tests | backend-api/src | core (**yours**) | WIP | leave | Never touched |
| CLEANUP_MANIFEST.md / CONSOLIDATED_PLANNING.md | bot-nation/ | core / legacy | untracked | defer | Reconcile CONSOLIDATED (was tracked at session start) |
| sites/{yope,synergy} | bot-nation/sites | Agency | separate repos | leave | Own .git (mercy-dept) |
| AutoResearchClaw/TradingAgents/hermes-*/last30days/*-api | inner root | Infra/external | separate repos | leave | Own .git; keep-both |

---

## 4. Roadmap (NOT WIRED / future phases)

| Feature | Owner | Dependencies | Phase | Notes / risks |
|---|---|---|---|---|
| Rotate projecT87 wallet key | P87/Infra | upstream repo access | **P4 (security, first)** | Private key in upstream git history |
| Deploy projecT87 + set env | P87/Infra | rotate key; Render deploy; secrets | P4 | Unblocks read-only DeFi views (currently 503) |
| Build + deploy console (`/defi` live) | Build | Pages deploy; hostname | P4 | No deployed console URL exists |
| Borrow execution-after-approval | P87 | approval→executor; human gate | P5 | Keep non-autonomous; on-chain risk |
| `defi_*` autonomous dispatch → projecT87 | P87 | AgentActor handlers; borrow gate | P5 | Touches your WIP AgentActor.ts |
| projecT87 real-estate disposition | Bailey vs delete | ownership decision | P4-cleanup | §2.3 ambiguity |
| Un-pause Bailey crons | Bailey | scoring→Retell verified; DNC/compliance | P5 | Pipeline code ready |
| Agency automation | Agency | task flow + crons (none exist) | P6 | Personas + sites only |
| Delete moltbot root scaffolding | Infra | delete approval | P6-cleanup | Verified dead §2.2 |
| Optional: de-git engine dirs; flatten double-nest | Infra | your go-ahead | P6 | Deferred earlier |

---

## 5. Cron inventory (verified from wrangler.jsonc + scheduled.ts)

**ACTIVE (12, Finance/Schwab):** `*/5 * * * *` task dispatcher · `0 */6 * * *` Schwab token heartbeat ·
`*/5 13-20 * * 1-5` market-hours position stream · `30 12` morning brief · `30 13` daily price targets ·
`30 18` midday analysis · `0 19` position exit monitor¹ · `30 20` EOD wrap · `35 20` quality metrics ·
`0 12` finance-intel progress (flag-gated) · `0 0 * * 1` weekly trade planning¹ · `0 13 * * 1` OpenRouter balance.
¹ `0 19 * * 1-5` and `0 0 * * 1` are configured but have **no handler** (dead no-ops).

**PAUSED block (9, non-finance):** daily intel check · daily research digest · weekly intel brief ·
weekly skill refinement · supervisor 4-hour reminders · weekly YouTube market intel · weekly Telegram quality
review · weekly mission/directives review → **8 PAUSED (handlers exist)**; `40 3 1 5 *` R16 → **DEAD (no handler)**.

---

## 6. Follow-up audit (left open, per Phase-4 rules)

- **Moltbot root scaffolding deletion** — verified dead (§2.2); needs explicit delete approval.
- **projecT87 real-estate module** — ambiguous (§2.3); decide delete / move→Bailey / keep-internal.
- **searxng/** — verified live; no action, but confirm before any future restructuring.
- **Stray junk** (`npx`, `notepad`, `type`, `test-time-parser*.js`) — not in the approved deletion list; confirm.
- **`CONSOLIDATED_PLANNING.md`** — untracked now but was tracked at session start; reconcile.
- **Branch merge** — `chore/phase0-cleanup` → `main` after review.
- **Environment** — C: drive full; unrelated to the repo but blocks writes.

---

## 7. Recommendation

**Complete:** Phases 0–3 + the P4 non-destructive fixes below. Finance is the live, usable core.
**Next execution phase = P4 activation**, gated first on the **security follow-up (rotate the projecT87
wallet key)** before deploying with live credentials, then deploy projecT87 + console + set env.
Everything under §6 stays a documented follow-up — no uncertain deletions or moves performed.
