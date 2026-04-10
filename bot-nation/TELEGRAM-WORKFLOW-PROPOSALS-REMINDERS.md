# Telegram Workflow: Proposals System + Supervisor Reminders

**Purpose:** Teams propose crons → System auto-approves or routes to you → Executes with Haiku routing

---

## Flow 1: Team Proposes a Cron

### **Use Case: Finance Lead Proposes Daily Cost Report**

```
Finance Lead (via Telegram):
"I want to run cost_report every day at 9am with anomaly detection"

Bot:
"📋 New proposal detected: cron_request
 Team: Finance
 Task: cost_report
 When: 0 9 * * * (daily 9am)

 [✅ Create Proposal] [❌ Cancel]"

Finance Lead:
[clicks ✅ Create Proposal]

Bot:
"✅ Proposal created
 ID: prop-finance-cost-001
 Status: Pending approval

 /approve prop-finance-cost-001   (you approve)
 /reject prop-finance-cost-001    (you reject)"

You (via Telegram):
"/approve prop-finance-cost-001"

Bot:
"✅ APPROVED
 Cron created: Daily 9:00 AM
 First run: Tomorrow at 9:00 AM

 Team: Finance Lead
 Task: cost_report
 Status: 🟢 ACTIVE

 Next run: Tomorrow 9:00am
 View: /crons"

[Next day, 9:00 AM]

Bot (auto):
"✅ cost_report complete in 12s
 Daily spend: $0.18
 Anomalies: None

 [View full report] [Archive]"
```

---

## Flow 2: Bailey Team Proposes Propstream Lead Score

### **Use Case: Bailey Lead Wants Daily Lead Scoring at 9am**

```
Bailey Lead (voice note):
"We need to score one lead every morning at 9am for the PropStream list"

Bot:
"🎙️ Transcribed: 'We need to score one lead every morning...'"
"Routing as: proposal (cron_request)"

Bailey Lead (Telegram follow-up):
"/propose cron_request
 Task: propstream_lead_score
 When: 0 9 * * *
 Input: PropStream list CT-Hartford-PreFC-30"

Bot (Haiku classifier analyzes):
"✅ Proposal valid
 Team: Bailey
 Task: propstream_lead_score
 Frequency: Daily 9:00 AM
 Input source: CT-Hartford-PreFC-30
 Estimated cost: $0.22/day

 Ready to create? [✅ Yes] [❌ Edit]"

Bailey Lead:
[✅ Yes]

Bot:
"✅ Proposal created: prop-bailey-daily-score-001
 Waiting for approval from Nation Supervisor...

 /approve prop-bailey-daily-score-001"

You:
"/approve prop-bailey-daily-score-001"

Bot:
"✅ APPROVED & ACTIVATED
 🏘️  propstream_lead_score
 Schedule: Daily 9:00 AM
 Team: Bailey
 Status: 🟢 LIVE

 First run: Tomorrow 9:00 AM
 Send to: Telegram + PropStream notes"

[Next day, 9:00 AM]

Bot (auto):
"✅ propstream_lead_score complete

 Lead #42 from CT-Hartford-PreFC-30
 Address: 412 Maple St, Springfield, IL
 Owner: John Smith (Absentee)

 SCORE: 11/12 🔴 HOT
 ├─ Distress: 3/4
 ├─ Equity: 3/3
 ├─ Ownership: 3/3
 └─ Market: 2/2

 Script ready for 9:30am call
 Status: READY FOR VOICE OUTREACH

 [Call Now] [Schedule] [Skip to #43]"

[At 9:30 AM, Bailey voice agent fires]

Bot (auto):
"🎙️ Starting seller call...
 Lead: #42 (411 Maple St)
 Script: Hot absentee owner
 Dialing: (555) 123-4567..."

[Call completes]

Bot (auto):
"✅ Call complete in 3:42m

 Disposition: QUALIFIED (wants offer)
 Key fields extracted:
 ├─ Target price: $380k
 ├─ Timeline: 30-60 days
 ├─ Condition: Fair (needs rehab)
 └─ Notes: Open to assignment

 Next action: Send to human rep for PSA
 [Review] [Schedule follow-up] [DNC]"
```

---

## Flow 3: Supervisor 4-Hour Reminder

### **Cron Fires Every 4 Hours**

**6:00 AM — Morning Briefing**

```
Bot (Nation Supervisor auto):

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏛️  MORNING BRIEFING — 6:00 AM
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ OVERNIGHT RUNS (10pm - 6am):
├─ Finance: cost_report [5:47am] ✓ $0.12
├─ Intel: batch-review [2:15am] ✓ $0.48
├─ Research: weekly-brief [3:22am] ✓ $0.35
├─ projecT87: health-factor [1:30am] ✓ $0.06
└─ Intel-researcher: repo-crawl [1:15am] ✓ $0.25

TOTAL OVERNIGHT: $1.26 spend

⏳ SCHEDULED TODAY:
09:00 → Bailey: propstream_lead_score [PENDING]
09:00 → Growth: pipeline-check [PENDING]
09:00 → Research: daily-research [PENDING]
09:30 → Bailey: seller_outbound_call [AUTO]
10:00 → Intel: batch-review [PENDING]
14:00 → Growth: lead-scoring [PENDING]
16:00 → Agency: crm-hygiene [PENDING]

❌ PROBLEMS:
├─ Infra Lead: DO health-check FAILING
│  Error: "Stale lock timeout (5min default)"
│  Impact: Queue depth = 8 (critical)
│  Action: Need Phase 1 fix (30s re-alarm)
│
└─ 2 Agents MISSING scheduled task:
   ├─ agent-agency-guardrail
   └─ agent-p87-observability
   Action: /propose cron_request for each

🟢 COST ANALYSIS:
├─ Yesterday: $2.14 (4% under budget)
├─ 7-day avg: $1.87/day
├─ Monthly projection: $56.10 (on track)

🎯 YOUR ACTIONS:
[1] Approve 2 pending proposals (5min)
[2] Fix stale lock re-alarm (Phase 1)
[3] Propose crons for 2 missing agents

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/stats — Full dashboard
/crons — Active schedule
/proposals — Pending approvals
```

---

**10:00 AM — Mid-Morning Check**

```
Bot (Nation Supervisor auto):

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚙️  MID-MORNING CHECK — 10:00 AM
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ COMPLETED (9am batch):
├─ Bailey: propstream_lead_score [9:05am] ✓
│  Lead #42 scored 11/12 HOT
│  Script: Ready for 9:30am call
│
├─ Growth: pipeline-check [9:12am] ✓
│  Found 3 qualified leads from yesterday
│  Action: Route to human reps
│
└─ Research: daily-research [9:18am] ✓
│  Question: What is latest Aave V3 update?
│  Answered: ✓ (GLM-5, 42s)

🎙️  CALL STATUS:
├─ Bailey voice call started 9:30am
├─ Current: In progress (talking)
└─ Duration so far: 2:15

⏳ RUNNING RIGHT NOW:
├─ Intel: batch-review [started 10:01am]
│  Processing 5 GitHub repos
│  Est. complete: 10:35am

🔴 DELAYED:
├─ Agency: crm-hygiene [DUE 9:00am, NOT YET RUN]
│  Reason: Waiting for your approval
│  Action: /approve prop-agency-crm-001

💰 COST SO FAR TODAY: $0.58

NEXT IN QUEUE:
14:00 → Growth: lead-scoring
16:00 → Agency: crm-hygiene (if approved)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[📋 See Pending Approvals]
```

---

**2:00 PM — Afternoon Checkpoint**

```
Bot (Nation Supervisor auto):

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 AFTERNOON CHECKPOINT — 2:00 PM
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ CALLS COMPLETED:
├─ Bailey voice call #1 [completed 9:45am]
│  Lead #42: QUALIFIED (target $380k)
│  Disposition: Wants offer
│  Transcript: 1,247 tokens analyzed
│  Next: Human rep follow-up
│
└─ Bailey voice call #2 [completed 12:30pm]
   Lead #43: WARM (needs follow-up)
   Disposition: Call back Friday
   Transcript: 892 tokens analyzed

✅ COMPLETED THIS HOUR:
├─ Growth: lead-scoring [14:02] ✓
│  Scored 7 leads from past week
│  Top 3: Ready for outreach
│
└─ Intel: batch-review [ongoing since 10:01]
   Status: 4/5 repos assessed
   Est. done: 2:15pm

📈 DAILY METRICS:
├─ Tasks completed: 11
├─ Total cost so far: $1.82
├─ Calls made: 2
├─ Qualified leads: 1
├─ Warm leads: 1

⚠️  ISSUES:
├─ Agency: crm-hygiene still BLOCKED (waiting approval)
├─ Infra: DO queue depth still high (7, was 8)

🎯 REMAINING TODAY:
├─ 16:00 → Agency: crm-hygiene [IF APPROVED]
├─ 16:30 → Bailey: call #3 (auto-triggered)
├─ 18:00 → Evening summary reminder

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Approve crm-hygiene cron] — /approve prop-agency-crm-001
```

---

**6:00 PM — Evening Summary**

```
Bot (Nation Supervisor auto):

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 EVENING SUMMARY — 6:00 PM
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ TODAY'S WORK (completed):
├─ Tasks: 15 completed
├─ Calls: 3 completed (2 qualified, 1 warm)
├─ Repos reviewed: 5 assessed (all safe to adopt)
├─ Cost reports: 1 generated
├─ Proposals approved: 2

📊 DAILY METRICS:
├─ Total spend: $3.14
├─ Tokens used: 847,392 (85% Haiku, 15% Sonnet/Kimi)
├─ Calls quality: 2/3 qualified
├─ Proposition rate: 67%
├─ Avg call duration: 3:24

🏆 TOP PERFORMERS TODAY:
├─ 🥇 Bailey Team: 3 calls, 2 qualified (67%)
├─ 🥈 Finance Team: 1 cost_report (anomaly detection flagged $0.42 overuse)
├─ 🥉 Intel Team: 5 repos assessed (all approved)

❌ BLOCKERS:
├─ Stale lock re-alarm (Phase 1) — still needed
├─ Agent introspection tool — agents still hallucinate
└─ Proposal 1 pending: CRM hygiene cron

🔮 TOMORROW'S FORECAST:
├─ Bailey: 3 scheduled calls (leads #44, #45, #46)
├─ Finance: 1 cost report (9am)
├─ Research: 1 research task (TBD)
├─ Projected spend: $3.40
├─ Likelihood: 87% on-time completion

WEEK PROJECTION:
├─ Calls: 15 (on pace for 3 deals)
├─ Cost: $22.50 (on budget)
├─ Qualified leads: 10+
└─ Deals likely to close: 2-3

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

YOUR ACTION ITEMS:
[1] Approve crm-hygiene cron (1min)
[2] Review 2 qualified leads (5min)
[3] Phase 1 stability fix (30min)

[View detailed report] [Export CSV]
```

---

## Flow 4: /crons Command — View All Scheduled Tasks

```
You: /crons

Bot:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🕐 ACTIVE CRONS (16 total)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🟢 RUNNING NOW:
├─ bailey-voice-call-1 [started 2:45pm, +2:10 elapsed]
└─ intel-batch-review [started 10:01am, +4:14 elapsed]

⏳ NEXT 4 HOURS:
├─ 16:00 → agency-crm-hygiene [PENDING APPROVAL]
├─ 16:30 → bailey-voice-call-2
├─ 18:00 → supervisor-evening-summary (auto)
└─ 18:30 → p87-health-monitor

📅 DAILY CRONS (run every day):
├─ 06:00 → supervisor-morning-brief
├─ 09:00 → finance-lead-cost-report ✅
├─ 09:00 → bailey-propstream-score ✅
├─ 09:00 → growth-lead-pipeline
├─ 09:30 → bailey-voice-call-1
├─ 09:30 → bailey-voice-call-2
├─ 10:00 → intel-batch-review (2x/week)
├─ 10:00 → growth-social-content (1x/week)
├─ 14:00 → growth-lead-scoring
├─ 16:00 → agency-crm-hygiene
└─ 18:00 → supervisor-evening-summary

📅 WEEKLY CRONS:
├─ MON 09:00 → research-lead-weekly-brief
├─ WED 10:00 → researcher-1-deep-dive
├─ THU 11:00 → intel-assessor-value-analysis
├─ FRI 14:00 → researcher-2-knowledge-curation
├─ FRI 16:00 → agency-revops-crm-hygiene
└─ SAT 01:00 → intel-researcher-github-crawl

💰 MONTHLY COST:
├─ Daily runs: $56.10
├─ Weekly runs: $24.30
├─ Total: $80.40/month (on budget)

📊 SUCCESS RATE:
├─ Last 30 runs: 28/30 succeeded (93%)
├─ Avg completion time: 18s
├─ Avg cost per run: $0.11

❌ DISABLED CRONS (waiting approval):
├─ agency-crm-hygiene [prop-agency-crm-001]
   Status: Pending your approval
   Action: /approve prop-agency-crm-001

└─ p87-observability [not yet proposed]
   Status: Missing proposal
   Action: /propose cron_request

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Create new cron] /propose cron_request
[View runs] /task-history
[Cost analysis] /cost-breakdown
```

---

## Flow 5: /proposals Command — Pending Approvals

```
You: /proposals

Bot:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 PENDING PROPOSALS (2)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[1] prop-agency-crm-001
    Type: cron_request
    Team: Agency (RevOps)
    Task: crm_hygiene
    When: 0 16 * * FRI (Friday 4pm)
    Cost: ~$0.10/run = $0.40/week
    Proposed by: agent-agency-revops
    Status: ⏳ WAITING YOUR APPROVAL
    Created: 6:32 AM today

    Summary: "Weekly CRM hygiene check —
             deduplication, field validation,
             stale record cleanup"

    [✅ Approve] [❌ Reject] [❓ Ask Team]

[2] prop-p87-observability-001
    Type: dept_task
    Team: projecT87
    Task: p87-observability (new agent role)
    Responsibility: Monitor all DeFi runs +
                    produce daily reports
    Status: ⏳ WAITING YOUR APPROVAL
    Proposed by: agent-p87-planner
    Created: 2:15 PM today

    Summary: "Add observability agent to track
             every DeFi execution: cost,
             execution time, slippage, profits"

    [✅ Approve] [❌ Reject] [❓ Ask Team]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/approve prop-agency-crm-001
/reject prop-p87-observability-001
/history — View past proposals
```

---

## Implementation: Database Schema

```sql
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,  -- 'cron_request' | 'dept_task' | 'tool_add' | 'agent_add'
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,

  -- For cron proposals
  cron_expression TEXT,  -- e.g., "0 9 * * *"
  task_kind TEXT,        -- e.g., "cost_report", "propstream_lead_score"
  task_input TEXT,       -- JSON input for task
  estimated_cost_per_run DECIMAL,

  status TEXT DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected'
  created_at TEXT,
  created_by TEXT,       -- agent_id who proposed
  approved_at TEXT,
  approved_by TEXT,      -- you (user)
  rejection_reason TEXT
);

-- Link approved proposals to active crons
CREATE TABLE scheduled_crons (
  id TEXT PRIMARY KEY,
  proposal_id TEXT REFERENCES proposals(id),
  job_id TEXT,           -- CronCreate() job_id
  status TEXT DEFAULT 'active',  -- 'active' | 'paused' | 'disabled'
  next_run_at TEXT,
  last_run_at TEXT,
  created_at TEXT
);
```

---

## Haiku Classifier for Proposals

```typescript
// telegram.ts: handleProposalSubmission

async function classifyProposal(
  text: string,
  teamId: string,
  agentId: string,
): Promise<ProposalClassification> {
  const prompt = `
    Classify this proposal:
    Team: ${teamId}
    Agent: ${agentId}
    Proposal: "${text}"

    Return JSON:
    {
      "type": "cron_request" | "dept_task" | "tool_add" | "agent_add",
      "taskKind": "research" | "cost_report" | ...,
      "cronExpression": "0 9 * * *" or null,
      "isValid": true | false,
      "feedback": "reason if invalid"
    }
  `;

  const result = await openai.chat.completions.create({
    model: "gpt-3.5-turbo",  // Haiku-equivalent model
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,  // Deterministic
  });

  return JSON.parse(result.choices[0].message.content);
}
```

---

## Ready to Build?

**All flows above require:**

1. ✅ Proposals table
2. ✅ /propose, /approve, /reject commands in telegram.ts
3. ✅ Haiku classifier (cron expression validator)
4. ✅ CronCreate integration (cron executor)
5. ✅ Supervisor reminder cron (every 4 hours)

**Time estimate:** 3-4 hours to code all 5 + test

**Should I start?** Want specific implementations first (TypeScript code), or shall we validate the schema + flows?
