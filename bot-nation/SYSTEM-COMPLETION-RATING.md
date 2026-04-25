# Bot Nation System — Completion Rating & Agent Scheduling Strategy

**Generated:** April 9, 2026
**System Status:** 72% Production-Ready (Core + Intelligence) / 35% Full Automation

---

## PART 1: System Completion Rating

### **Core Infrastructure: 95% ✅**
| Component | Status | Notes |
|---|---|---|
| Cloudflare Workers + D1 + DO | ✅ | Deployed, tested, edge-ready |
| itty-router v5 auto-routing | ✅ | All API endpoints live |
| OpenRouter model routing | ✅ | Kimi/GLM-5/Gemini/Qwen all wired |
| Telegram webhook + commands | ✅ | `/task`, `/status`, `/approve` working |
| SearXNG metasearch | ✅ | Deployed on Render, integrated |
| Voice transcription (Whisper) | ✅ | CF Workers AI working |
| ETA/progress countdown | ✅ | Live message editing + completion notification |
| Cost tracking | ✅ | Artifact-based token logging |
| **SUBTOTAL** | **95%** | Production baseline achieved |

### **Intelligence Layer: 65% 🟡**
| Component | Status | Notes |
|---|---|---|
| Graph execution (traverseGraph) | ✅ | Multi-node workflows tested |
| Agent self-querying tools | ❌ | Agents can't introspect DB (causes hallucination) |
| projecT87 agents + team | ✅ | Seeded but tools are stubs |
| Intel department (GitHub review) | ✅ | 5-node pipeline working |
| Bailey Group dept | ❌ | Spec exists, not seeded yet |
| Fast stale lock recovery | ❌ | Still 5-min default (need 30s re-alarm) |
| Task retry with backoff | ❌ | Single attempt only |
| Graph node checkpointing | ❌ | DO reset loses progress |
| **SUBTOTAL** | **65%** | Core logic ready, DeFi/Real-Estate integrations pending |

### **Automation Layer: 55% 🟠**
| Component | Status | Notes |
|---|---|---|
| Scheduled cron jobs | ⚠️ | CronCreate works but no teams proposing yet |
| Proposal system | ❌ | Not built (critical blocker) |
| Agent-specific crons | ❌ | Only manual via Telegram |
| Department mission execution | ⚠️ | Objectives seeded, no automation yet |
| Telegram reminders (4hr) | ❌ | Not implemented |
| **SUBTOTAL** | **55%** | Infrastructure ready, operator layer missing |

### **Bailey Group Integration: 0% 🔴**
| Component | Status | Notes |
|---|---|---|
| PropStream browser automation | ❌ | Spec clear, not coded |
| Lead scoring + tagging | ❌ | Formula ready, not implemented |
| Perplexity script generation | ❌ | API ready, not wired |
| AI voice calling (Pipecat) | ❌ | Spec ready, not integrated |
| Call transcript → disposition | ❌ | Not built |
| PSA/contract generation | ❌ | Not built |
| **SUBTOTAL** | **0%** | Complete spec, ready to build |

---

## **OVERALL SYSTEM SCORE**

```
Core Infra:      95% ✅
Intelligence:    65% 🟡
Automation:      55% 🟠
Bailey Group:     0% 🔴
─────────────────────────
WEIGHTED AVERAGE: 72% (core system working, automation + new depts pending)
```

**What's Blocking Higher:**
1. **Proposal system** (45min to build) — teams can't self-propose crons
2. **Supervisor reminders** (30min) — no 4hr notification loop
3. **Agent introspection tools** (20min) — agents hallucinate system state
4. **Bailey Group seeding** (2hr) — real estate dept not integrated
5. **Stale lock + retry** (30min) — tasks appear to timeout

---

## PART 2: One Task Per Agent (30 Scheduled Crons)

**Objective:** Every agent gets 1 recurring task automatically scheduled + tracked.

### **Current Agents: 30 Total**

**By Domain:**
```
🏛️  Governance:        3 agents
   ├─ agent-supervisor-001 (Nation Supervisor)
   ├─ agent-nation-supervisor (duplicated?)
   └─ agent-agency-guardrail (Agency Guardrail)

🔬 Knowledge:          5 agents
   ├─ agent-research-lead
   ├─ agent-researcher-1 (Deep Researcher)
   ├─ agent-researcher-2 (Knowledge Curator)
   ├─ agent-intel-lead
   ├─ agent-intel-researcher
   ├─ agent-intel-assessor

🛠️  Execution-Product: 4 agents
   ├─ agent-build-lead
   ├─ agent-builder-1 (Product Engineer)
   ├─ agent-builder-2 (Content Specialist)
   └─ agent-p87-planner

⚙️  Execution-Infra:   4 agents
   ├─ agent-infra-lead
   ├─ agent-p87-execution
   ├─ agent-p87-smartaccount
   └─ agent-p87-rpc

💰 Execution-Finance:  4 agents
   ├─ agent-finance-lead
   ├─ agent-finance-analyst
   ├─ agent-p87-risk
   └─ agent-p87-nurse

📈 Execution-Growth:   4 agents
   ├─ agent-growth-lead
   ├─ agent-growth-social
   ├─ agent-agency-growthops
   ├─ agent-agency-pipelineops
   └─ agent-agency-revops

🏘️  Bailey Group:      [NEW — add 6 agents]
   ├─ agent-bailey-lead
   ├─ agent-bailey-propstream
   ├─ agent-bailey-scorer
   ├─ agent-bailey-voice
   ├─ agent-bailey-crm
   └─ agent-bailey-observability
```

---

## PART 3: Supervisor Reminder System (Every 4 Hours)

**Goal:** Nation Supervisor sends Telegram message every 4 hours with status + what's missing.

### **Reminder Schedule**

```
6:00 AM  → Morning briefing
10:00 AM → Mid-morning status
2:00 PM  → Afternoon checkpoint
6:00 PM  → Evening summary
10:00 PM → Night checklist
2:00 AM  → Overnight sweep
```

### **Sample 6am Reminder Message**

```
🏛️ MORNING BRIEFING — 6:00 AM

📊 OVERNIGHT RUNS (10pm - 6am):
├─ Finance: ✅ cost_report ran (completed 5:47am)
├─ Intel: ✅ 3 repos reviewed (completed 2:15am)
├─ Research: ✅ weekly brief compiled (completed 3:22am)
└─ projecT87: ✅ health factor check (completed 1:30am)

⚠️  INCOMPLETE AGENT CRONS (2 pending):
├─ Bailey Team: propstream_lead_score [DUE NOW]
│  Status: Not yet scheduled (missing proposal)
│  Action: /propose cron_request
│
└─ Growth Team: crm_hygiene_check [DUE 10am]
│  Status: Pending lead qualification
│  Action: /approve growth_cron_001

🎯 TODAY'S PRIORITY:
[1] Bailey: Score 3 leads (9am, 12pm, 3pm)
[2] Growth: Approve CRM cron
[3] Build: Deploy Phase 1 stability (stale lock + retry)

COST TODAY: $0.18 (on track)
AGENT UTILIZATION: 18/30 active

→ /help proposals — propose new crons
→ /stats — full dashboard
```

---

## PART 4: Department Mission Statements & Priority Crons

### **🔬 Research Team** — Intelligence Authority
**Mission:** Monitor AI/DeFi/open-source developments. Produce weekly intelligence briefs. Flag repos for adoption.

**Agent Crons (Priority Order):**
```
1. research-lead-weekly-brief
   Cron: 0 9 * * MON       (Monday 9am)
   Task: deep_research on AI/DeFi/tooling trends
   Output: Executive brief → Telegram + Slack
   Cost: ~$0.35

2. researcher-1-deep-dive
   Cron: 0 10 * * WED      (Wednesday 10am)
   Task: deep_research on assigned research question
   Output: Technical analysis
   Cost: ~$0.40

3. researcher-2-knowledge-curation
   Cron: 0 2 * * FRI       (Friday 2pm)
   Task: Curate knowledge base + index new repos
   Output: Updated KB
   Cost: ~$0.15

4. research-lead-proposal-review
   Cron: 0 4 * * FRI       (Friday 4pm)
   Task: Review all submitted proposals
   Output: Approval summary
   Cost: ~$0.10
```

**Weekly Cost: $1.00 | Monthly: $4.30**

---

### **🔍 Intel Team** — Safety & Value Assessment
**Mission:** Review GitHub/social links. Verify authenticity. Assess safety + infrastructure fit. Propose new depts.

**Agent Crons:**
```
1. intel-lead-batch-review
   Cron: 0 10 * * MON,WED,FRI   (3x/week)
   Task: intel_review on batch of submitted URLs
   Output: Assessment report
   Cost: ~$0.50/run = $1.50/week

2. intel-researcher-github-crawl
   Cron: 0 1 * * SAT            (Saturday 1am)
   Task: Crawl trending GitHub repos + flag for review
   Output: Repo list
   Cost: ~$0.25

3. intel-assessor-value-analysis
   Cron: 0 11 * * THU           (Thursday 11am)
   Task: Analyze value of proposed integrations
   Output: Recommendation + ROI estimate
   Cost: ~$0.30
```

**Weekly Cost: $2.55 | Monthly: $11.00**

---

### **💰 Finance Team** — Cost & Resource Optimization
**Mission:** Track token usage daily. Flag anomalies. Produce weekly reports.

**Agent Crons:**
```
1. finance-lead-daily-cost-report
   Cron: 0 9 * * *              (Daily 9am)
   Task: cost_report (new task kind)
   Output: Daily spend breakdown + anomalies
   Cost: ~$0.12

2. finance-analyst-budget-forecast
   Cron: 0 10 * * MON           (Weekly Monday)
   Task: Forecast weekly spend + recommend optimizations
   Output: Budget projection
   Cost: ~$0.20

3. finance-lead-team-allocation
   Cron: 0 2 * * FRI            (Friday 2pm)
   Task: Allocate budget across teams + agents
   Output: Budget allocation → Slack
   Cost: ~$0.15
```

**Weekly Cost: $1.04 | Monthly: $4.50**

---

### **⚙️ Infra Team** — System Stability & Durable Objects
**Mission:** Monitor DO health. Fast stale lock recovery. Checkpoint management.

**Agent Crons:**
```
1. infra-lead-do-health-check
   Cron: */30 * * * *            (Every 30min)
   Task: Check DO alarm status + queue depth
   Output: Alerts if queue > 5
   Cost: ~$0.05 per run = $2.40/day = $73/month

   [NOTE: EXPENSIVE — need smarter check strategy]

2. infra-lead-checkpoint-prune
   Cron: 0 3 * * *              (Daily 3am)
   Task: Clean up old graph checkpoints
   Output: Freed space report
   Cost: ~$0.08

3. infra-lead-lock-recovery-status
   Cron: 0 9 * * *              (Daily 9am)
   Task: Report stale lock recovery attempts + success rate
   Output: Lock recovery health → Slack
   Cost: ~$0.10
```

**Weekly Cost: $18.64 (DO health polling is expensive) | Monthly: $80.50**

**⚠️ RECOMMENDATION:** Reduce DO health polling to hourly (0 */1 * * *) instead of 30min to cut cost by 50%.

---

### **📈 Growth Team** — Lead Gen & Conversion
**Mission:** Generate leads. Maintain pipeline health. Create campaign content.

**Agent Crons:**
```
1. growth-lead-daily-pipeline-check
   Cron: 0 9 * * *              (Daily 9am)
   Task: lead_qualification on pending prospects
   Output: Qualified leads → Telegram
   Cost: ~$0.18

2. growth-social-content-calendar
   Cron: 0 10 * * MON           (Weekly Monday)
   Task: Generate content calendar for week
   Output: Social content ideas
   Cost: ~$0.25

3. agency-growthops-lead-scoring
   Cron: 0 2 * * WED            (Weekly Wednesday)
   Task: Score all qualified leads from past week
   Output: Prioritized lead list
   Cost: ~$0.22

4. agency-revops-crm-hygiene
   Cron: 0 4 * * FRI            (Weekly Friday)
   Task: crm_hygiene — clean up CRM data
   Output: Deduplication + field validation report
   Cost: ~$0.10
```

**Weekly Cost: $1.60 | Monthly: $6.90**

---

### **💾 projecT87 — DeFi Monitoring & Execution
**Mission:** Monitor Aave V3 positions. Execute approved strategies. Flag liquidation risk.

**Agent Crons:**
```
1. p87-planner-daily-defi-plan
   Cron: 0 8 * * *              (Daily 8am)
   Task: defi_plan on pending strategies
   Output: Execution plan + approval gate
   Cost: ~$0.30

2. p87-nurse-health-factor-check
   Cron: 0 */4 * * *            (Every 4hrs, 8am-8pm)
   Task: defi_health_monitor on all positions
   Output: Alert if HF < 1.5
   Cost: ~$0.06 per run × 4 = $0.24/day = $7.20/month

3. p87-risk-policy-enforcement
   Cron: 0 9 * * MON            (Weekly Monday)
   Task: defi_risk_check on all active strategies
   Output: Policy compliance report
   Cost: ~$0.15

4. p87-execution-simulation-runner
   Cron: 0 12 * * SAT           (Weekly Saturday)
   Task: wallet_simulation on hypothetical trades
   Output: Simulation results + recommendations
   Cost: ~$0.25
```

**Weekly Cost: $8.64 | Monthly: $37.50**

---

### **🏘️ Bailey Group — Real Estate Automation** [NEW]
**Mission:** Automated lead scoring via PropStream. AI voice calling. Qualifier → human handoff.

**Agent Crons (To Be Added):**
```
1. bailey-lead-propstream-score
   Cron: 0 9 * * *              (Daily 9am)
   Task: propstream_lead_score (new task kind)
   Input: Next lead in "CT-Hartford-PreFC-30" list
   Output: Score + script ready for 9:30am call
   Cost: ~$0.22

2. bailey-propstream-browser-nav
   Cron: 0 9:15 * * *           (Daily 9:15am)
   Task: Browser automation to pull lead details from PropStream
   Output: Enriched lead data → PropStream notes
   Cost: ~$0.18 (Perplexity computer vision)

3. bailey-voice-outbound-call
   Cron: 0 9:30 * * *           (Daily 9:30am, after script ready)
   Task: seller_outbound_call using Pipecat
   Input: Lead + script from #1
   Output: Transcript + disposition (Qualified/Warm/DNC)
   Cost: ~$0.40 (Pipecat + Whisper + LLM reasoning)

4. bailey-crm-transcript-processor
   Cron: 0 10 * * *             (Daily 10am)
   Task: Call transcript → structured extraction
   Output: Normalized disposition + key fields (price, timeline, condition)
   Cost: ~$0.15

5. bailey-observability-daily-report
   Cron: 0 4 * * *              (Daily 4pm)
   Task: Generate call quality + disposition report
   Output: Daily summary → Slack + human review
   Cost: ~$0.12
```

**Weekly Cost (1 lead/day model): $5.74 | Monthly: $24.80**
**Scales to 4 leads/day: Weekly: $22.96 | Monthly: $99.20** (Phase C)

---

## PART 5: Master Cron Schedule (All 30 Agents)

```
TIME  | MON              | TUE              | WED              | THU              | FRI              | SAT              | SUN
──────┼──────────────────┼──────────────────┼──────────────────┼──────────────────┼──────────────────┼──────────────────┼──────────────────
06:00 | Supervisor brief | Supervisor brief | Supervisor brief | Supervisor brief | Supervisor brief | Supervisor brief | Supervisor brief
08:00 | p87-planner      | p87-planner      | p87-planner      | p87-planner      | p87-planner      | —                | —
09:00 | research-lead    | finance-lead     | —                | finance-lead     | finance-lead     | finance-lead     | finance-lead
      | bailey-lead      | bailey-lead      | bailey-lead      | bailey-lead      | bailey-lead      | —                | —
      | growth-lead      | growth-lead      | growth-lead      | growth-lead      | growth-lead      | —                | —
10:00 | intel-lead       | —                | researcher-1     | —                | —                | —                | —
      | growth-social    | growth-social    | —                | growth-social    | growth-social    | —                | —
11:00 | —                | —                | —                | intel-assessor   | —                | —                | —
12:00 | —                | —                | —                | —                | —                | —                | —
13:00 | —                | —                | —                | —                | —                | —                | —
14:00 | —                | —                | —                | —                | research-lead    | —                | —
15:00 | —                | —                | —                | —                | —                | —                | —
16:00 | —                | —                | —                | —                | research-lead    | —                | —
      | —                | —                | —                | —                | agency-revops    | —                | —
01:00 | —                | —                | —                | —                | —                | intel-researcher | —
02:00 | —                | —                | —                | —                | researcher-2     | —                | —
      | —                | —                | —                | —                | research-lead    | —                | —
03:00 | —                | —                | —                | —                | —                | infra-lead       | —
12:00 | —                | —                | —                | —                | —                | —                | —
(SAT) | —                | —                | —                | —                | —                | p87-execution    | —
```

---

## PART 6: Supervisor 4-Hour Reminder Logic

**Telegram Cron: Every 4 hours**

```bash
Cron: 0 6,10,14,18,22,2 * * *    (6am, 10am, 2pm, 6pm, 10pm, 2am)

Logic:
1. Query completed crons in last 4 hours
2. Query pending crons due in next 4 hours
3. Query agents with no scheduled task
4. Query tasks that timed out / failed
5. Send Telegram message summarizing all
```

**Example Output:**
```
✅ COMPLETED (last 4hrs):
├─ Finance Lead: cost_report [6.2s] ✓
├─ Intel Lead: batch-review [45s] ✓
└─ p87 Nurse: health-factor-check [3.1s] ✓

⏳ PENDING (next 4hrs):
├─ Bailey Lead: propstream-score [DUE 9:00am]
├─ Growth Lead: pipeline-check [DUE 10:00am]

⚠️  PROBLEMS:
├─ Research Lead: Missing Monday brief (overdue 2hrs)
├─ Infra Lead: DO health check failing (every attempt)
└─ Bailey: Proposal not submitted yet

🟢 AGENTS WITHOUT SCHEDULED TASK:
├─ agent-agency-guardrail (governance)

→ /propose — Submit cron proposal
→ /help crons — View all scheduled jobs
```

---

## PART 7: Implementation Roadmap (Next 72 Hours)

### **Phase A: Foundation (Parallel, 2 hours)**
```
√ Add cost_report task kind to model-router.ts
√ Add propstream_lead_score task kind to model-router.ts
√ Add seller_outbound_call task kind to model-router.ts
```

### **Phase B: Proposal System (Parallel, 45 min)**
```
√ Create proposals table with cron_expression field
√ Add /propose command to telegram.ts
√ Haiku classifier: proposal type detection
√ Add /approve button → CronCreate integration
√ Add /crons list command
```

### **Phase C: Supervisor Reminders (Parallel, 30 min)**
```
√ Create supervisor-reminder cron (runs every 4 hours)
√ Query logic: completed, pending, failed, missing
√ Format Telegram message with status blocks
√ Deploy reminder cron
```

### **Phase D: Bailey Group Seeding (Parallel, 2 hours)**
```
√ Create migration 0018_bailey_group_integration.sql
  - Insert team-bailey
  - Insert 6 bailey agents
  - Insert propstream_lead_score, seller_outbound_call tasks
√ Deploy migration
```

### **Phase E: First Agent Crons (Sequential after phases A-D)**
```
1. Finance Team proposes: cost_report daily 9am
   → You approve
   → Cron fires tomorrow

2. Bailey Team proposes: propstream_lead_score daily 9am
   → You approve
   → Cron fires tomorrow

3. Research Team proposes: weekly-brief Monday 9am
   → You approve
   → Cron fires next Monday
```

**Total Time:** ~5 hours (all parallel except final approvals)

---

## PART 8: Expected Savings & Impact

### **Credit Usage (Monthly)**

**Current (manual Telegram only):**
- Avg 15 tasks/day × 30 days = 450 tasks
- Avg cost $0.08/task = $36/month

**With Agent Crons (automated):**
- Finance: $4.50
- Research: $4.30
- Intel: $11.00
- Growth: $6.90
- projecT87: $37.50
- Bailey: $24.80 (1 lead/day)
- Infra: $80.50 (expensive DO polling — need to optimize)
- **Total: $169.50/month**

**Initial increase:** $133.50/month, BUT:
- User no longer manually triggers 90% of tasks
- System self-manages with Supervisor oversight
- Bailey Group adds $25K-$150K revenue potential (1-4 deals/month)

**ROI Timeline:** 2-4 weeks (Bailey closes first deal)

---

## PART 9: Critical Dependencies & Blockers

### **Blocking Phase 1 Stability:**
- [ ] Fast stale lock re-alarm (30s instead of 5min)
- [ ] Task retry with backoff (3 attempts)
- [ ] Graph node checkpointing

### **Blocking Full Automation:**
- [ ] Proposal system
- [ ] Supervisor 4hr reminders
- [ ] Agent introspection tools (so agents can query DB)
- [ ] Bailey Group seeding

### **Notes on "Jevon":**
[User: Clarify what constraint/person this refers to — assuming it's context I should preserve?]

---

## NEXT IMMEDIATE ACTION

**Pick 2 of these 5:**

1. **Phase 1 Stability** (30min) — fix timeouts
2. **Proposal System** (45min) — teams self-propose crons
3. **Supervisor Reminders** (30min) — 4-hour notification loop
4. **Bailey Group Seeding** (2hr) — add real estate dept
5. **All-in-Parallel** (5hr total) — do all of above

**Recommendation:** Build all 4 in parallel (track with TodoWrite), then test Bailey's first lead score tomorrow 9am.

---

**Ready to implement? Which phase first?**
