# Bot-Nation Documentation Index

Complete documentation package for bot-nation system, architecture, teams, missions, and UI requirements.

## 📚 Documentation Files

All documentation is located in the bot-nation root directory. Start here:

### 1. **ARCHITECTURE.md** (40 min read)
**Purpose**: System design and technical architecture  
**Contains**:
- Nation Supervisor pattern (receptionist/gatekeeper routing)
- Complete message flow diagram
- Query classification system (simple/infrastructure/action)
- Microservice orchestration (parallel calls)
- Technology stack overview
- Database schema relationships
- Error handling patterns
- Webhook integration details

**Read this if**: You need to understand how bot-nation works end-to-end.

---

### 2. **AGENTS_INVENTORY.md** (35 min read)
**Purpose**: Complete catalog of all 16 agents  
**Contains**:
- All 16 agent profiles (name, team, capabilities, expertise)
- Agent matrix (who does what)
- Agent-to-microservice routing
- Agent communication flows
- Example query → agent routing
- Agent availability and status

**Read this if**: You need to assign agents to tasks or understand agent capabilities.

---

### 3. **TEAMS_DEPARTMENTS.md** (40 min read)
**Purpose**: Organizational structure and team responsibilities  
**Contains**:
- 9 teams across 6 departments
- Each team's mission statement
- Team dependencies and reporting structure
- Cross-department collaboration flows
- Quarterly planning cycles
- Team responsibilities and metrics

**Departments**:
- dept-research (3 teams)
- dept-infra (2 teams)
- dept-defi (2 teams)
- dept-growth (1 team)
- dept-real-estate (1 team)
- dept-sales (1 team)

**Read this if**: You need to understand organizational structure or assign tasks to teams.

---

### 4. **MICROSERVICES.md** (45 min read)
**Purpose**: API specifications for all 4 external microservices  
**Contains**:
- last30days-api (social + web research)
- hermes-api-minimal (self-improvement + skills)
- autoresearchclaw-api (academic research, 23 stages)
- tradingagents-api (4-agent consensus trading)
- Request/response schemas
- Configuration + environment variables
- Integration patterns
- Error handling + fallbacks
- Performance targets

**Read this if**: You need to debug microservice issues or integrate new services.

---

### 5. **DATABASE_SCHEMA.md** (30 min read)
**Purpose**: D1 database schema and data model  
**Contains**:
- Complete SQL table definitions
- Index strategy
- Chat messages table (conversation history)
- Skills table (learned procedures)
- Skill refinements (improvement tracking)
- Agents, teams, departments tables
- Tasks and metrics tables (optional)
- Usage examples (SQL queries)
- Retention policies
- Backup & recovery procedures

**Read this if**: You need to query the database or modify schema.

---

### 6. **DEPLOYMENT_STATUS.md** (25 min read)
**Purpose**: Current deployment status and operational details  
**Contains**:
- Main Worker URL + status
- Telegram integration status
- Database status
- All microservice URLs
- Environment variables (with redaction guidance)
- Deployment commands
- Monitoring & health checks
- Performance baselines
- Incident response procedures
- Cost analysis
- Upgrade path

**Read this if**: You need to deploy changes or understand current operational setup.

---

### 7. **MISSION_FRAMEWORK.md** (50 min read)
**Purpose**: Quarterly goals, agent assignments, and success metrics  
**Contains**:
- Q1 2024 strategic goals (5 key results)
- Each team's quarterly mission + goals
- Agent assignments to tasks
- Success metrics per team
- Cron job scheduling (*/5 health checks, daily digests, etc.)
- Agent hours allocation
- Dependencies and critical paths
- Dashboard KPIs to track

**Read this if**: You need to schedule agents, define team goals, or track progress.

---

### 8. **SKILLS_CATALOG.md** (35 min read)
**Purpose**: Skill system (learning, refinement, retrieval)  
**Contains**:
- Skill lifecycle (create → use → refine)
- Skill structure + examples
- Skill creation process (from task completion)
- Skill retrieval algorithm (pattern matching)
- Skill quality scoring (0-1 scale)
- Current skill library status
- Refinement examples
- Integration with LLM system prompts
- Feedback loops
- Skill archival + deprecation

**Read this if**: You need to create skills, understand the learning system, or improve skill quality.

---

### 9. **UI_REQUIREMENTS.md** (40 min read)
**Purpose**: Web dashboard specifications and design system  
**Contains**:
- 6 dashboard pages:
  1. Home/Overview (KPIs, system status)
  2. Trading Signals (real-time recommendations)
  3. Skill Library (search, filter, refine)
  4. Agent Status (monitor 16 agents)
  5. System Health (infrastructure monitoring)
  6. Settings (user preferences, API keys)
- Detailed mockups + wireframes (text-based)
- Design system (colors, typography, components)
- Technical stack (React, TailwindCSS, TradingView Charts)
- API endpoints to be built
- Performance targets
- Deployment strategy
- Roadmap (v0.1 MVP → v1.0 Production)

**Read this if**: You need to design/build the web UI or plan UI rollout.

---

## 🎯 How to Use These Documents

### Scenario 1: Understanding the System
**Read in order**:
1. ARCHITECTURE.md
2. MICROSERVICES.md
3. DATABASE_SCHEMA.md

### Scenario 2: Planning Next Sprint (Agent Tasks)
**Read in order**:
1. AGENTS_INVENTORY.md
2. TEAMS_DEPARTMENTS.md
3. MISSION_FRAMEWORK.md

### Scenario 3: Troubleshooting Issues
**Read**:
1. DEPLOYMENT_STATUS.md (current status)
2. MICROSERVICES.md (if API issue)
3. DATABASE_SCHEMA.md (if data issue)
4. ARCHITECTURE.md (if routing issue)

### Scenario 4: Building Dashboard
**Read**:
1. UI_REQUIREMENTS.md (specs + mockups)
2. ARCHITECTURE.md (backend API needs)
3. DEPLOYMENT_STATUS.md (deployment)

### Scenario 5: Creating/Managing Skills
**Read**:
1. SKILLS_CATALOG.md (system overview)
2. MICROSERVICES.md (hermes-api integration)
3. DATABASE_SCHEMA.md (skills table)

---

## 📊 Quick Reference

### Agent Quick Lookup

| Agent | Team | Department | Role |
|-------|------|-----------|------|
| analyst | team-research | dept-research | Data analysis, trends |
| researcher | team-research | dept-research | Academic research |
| synthesizer | team-research | dept-research | Skill creation |
| architect | team-build | dept-infra | System design |
| engineer | team-build | dept-infra | Implementation |
| devops | team-build | dept-infra | Deployment |
| sre | team-infra | dept-infra | Reliability |
| ops | team-infra | dept-infra | Operations |
| fundamental_analyst | team-finance | dept-defi | Financial analysis |
| sentiment_analyst | team-finance | dept-defi | Market sentiment |
| technical_analyst | team-finance | dept-defi | Chart analysis |
| risk_manager | team-finance | dept-defi | Portfolio risk |
| growth_agent | team-growth | dept-growth | User acquisition |
| intel_analyst | team-intel | dept-research | Competitive intel |
| bailey_specialist | team-bailey | dept-real-estate | Real estate |
| p87_analyst | team-p87 | dept-defi | DeFi projects |
| agency_lead | team-agency | dept-sales | Partnerships |

---

### Microservice Quick Lookup

| Service | URL | Purpose | Response Time |
|---------|-----|---------|---|
| last30days-api | https://last30days-api.onrender.com | Social + web research | 2-5s |
| hermes-api | https://hermes-api-minimal.onrender.com | Skill synthesis | 3-8s |
| autoresearchclaw-api | https://autoresearchclaw-api.onrender.com | Academic research | 10-30s |
| tradingagents-api | https://tradingagents-api-q747.onrender.com | Trading analysis | 2-4s |

---

### Key Metrics to Track

**User Growth**:
- MAU (Monthly Active Users): Target 500 by end of Q1
- DAU: Target 50% of MAU
- Churn: Target <5% monthly

**System Performance**:
- Uptime: Target 99.9%
- Response time (p95): <2s
- Error rate: <0.1%

**Trading Signals** (team-finance):
- Win rate: Target >55%
- Sharpe ratio: Target >1.5
- Max drawdown: Target <20%

**Skill Library**:
- Skills created: Target 50 by end of Q1
- Average quality: Target 0.75+
- Usage: Track refinements/skill

---

## 🔄 Document Maintenance

**Update Frequency**:
- ARCHITECTURE.md: Quarterly (major changes only)
- AGENTS_INVENTORY.md: Quarterly (agent additions)
- TEAMS_DEPARTMENTS.md: Quarterly (org changes)
- MICROSERVICES.md: As needed (new services)
- DATABASE_SCHEMA.md: As needed (migrations)
- DEPLOYMENT_STATUS.md: Weekly (version updates)
- MISSION_FRAMEWORK.md: Monthly (progress updates)
- SKILLS_CATALOG.md: Weekly (new skills)
- UI_REQUIREMENTS.md: Monthly (design updates)

**Last Updated**: 2024-01-15  
**Next Review**: 2024-02-01 (Mid-Q1 checkpoint)  
**Maintained By**: team-infra + team-research

---

## 🚀 For New Threads

When starting a new conversation thread about bot-nation:

1. **Provide context**: Paste this README + relevant .md files
2. **Specify scope**: Which team/agent/system are you working on?
3. **State objective**: What's your goal (build feature, fix bug, analyze data)?
4. **Reference docs**: "See ARCHITECTURE.md § Nation Supervisor for details"

**Example Prompt**:
```
I'm continuing work on bot-nation (see attached documentation).

Context: 
- System is production with 4 microservices integrated
- 16 agents across 6 departments
- Web UI needs to launch by Q1 end

Current Task:
- Build home dashboard (overview page)
- See UI_REQUIREMENTS.md for full specs

Question:
- Which API endpoints should I create first?
- See ARCHITECTURE.md for microservice patterns
```

---

## 📞 Key Contacts

**Technical Lead**: team-build (engineer + architect)  
**Operations**: team-infra (sre + ops)  
**Research**: team-research (analyst + researcher + synthesizer)  
**Trading**: team-finance (4 agents)  
**On-Call**: team-infra SRE (24/7 escalation)  

---

## 📝 Notes for Implementation

### High Priority (Q1)
- [ ] Launch web UI dashboard (UI_REQUIREMENTS.md)
- [ ] Achieve 99.9% uptime (DEPLOYMENT_STATUS.md)
- [ ] Create 50 skills (SKILLS_CATALOG.md)
- [ ] Establish partnerships (MISSION_FRAMEWORK.md)
- [ ] Grow to 500 MAU (MISSION_FRAMEWORK.md)

### Medium Priority (Q1-Q2)
- [ ] Implement thinkorswim integration (ARCHITECTURE.md)
- [ ] Build monitoring dashboard (DEPLOYMENT_STATUS.md)
- [ ] Improve skill quality to 0.75+ (SKILLS_CATALOG.md)
- [ ] Establish CI/CD pipelines (TEAMS_DEPARTMENTS.md)

### Lower Priority (Q2+)
- [ ] Scale to paid tier (DEPLOYMENT_STATUS.md)
- [ ] Geographic redundancy
- [ ] Advanced analytics
- [ ] Mobile app

---

## ✅ Document Verification Checklist

Before starting new implementation:

- [ ] Read ARCHITECTURE.md (understand system design)
- [ ] Identify agent(s) involved (AGENTS_INVENTORY.md)
- [ ] Check team/department (TEAMS_DEPARTMENTS.md)
- [ ] Review quarterly goals (MISSION_FRAMEWORK.md)
- [ ] Check database schema (DATABASE_SCHEMA.md)
- [ ] Verify microservice integration (MICROSERVICES.md)
- [ ] Check deployment status (DEPLOYMENT_STATUS.md)
- [ ] Note any UI changes needed (UI_REQUIREMENTS.md)

---

## 🎓 Learning Resources

**Understanding the System**:
1. Watch: Nation Supervisor flow (ARCHITECTURE.md)
2. Read: Query classification (ARCHITECTURE.md)
3. Learn: Skill creation process (SKILLS_CATALOG.md)
4. Study: Microservice orchestration (MICROSERVICES.md)

**Building Features**:
1. Identify: Which agent/team owns this?
2. Check: Quarterly goals (MISSION_FRAMEWORK.md)
3. Review: Database schema (DATABASE_SCHEMA.md)
4. Reference: API specs (MICROSERVICES.md)
5. Design: UI changes (UI_REQUIREMENTS.md)

**Troubleshooting**:
1. Check: Deployment status (DEPLOYMENT_STATUS.md)
2. Review: Architecture (ARCHITECTURE.md)
3. Debug: Database (DATABASE_SCHEMA.md)
4. Analyze: Microservices (MICROSERVICES.md)

---

**Happy building! 🚀**

For questions about specific systems, see the relevant .md file.  
For general architecture questions, start with ARCHITECTURE.md.  
For implementation guidance, see MISSION_FRAMEWORK.md.
