# Bot-Nation: UI Requirements

Complete specifications for web UI dashboard, design system, and user interface requirements.

## UI Overview

Bot-nation needs a **web-based dashboard** to visualize agent activity, skill library, trading signals, and system health.

**Current Status**: Telegram-only, text-based  
**Goal**: Launch web UI v1 by end of Q1 (Week 9)  
**Target Users**: Traders, researchers, platform administrators  

---

## Dashboard Pages

### 1. Home / Overview Dashboard

**Purpose**: Real-time system status and key metrics  
**Access**: All users  
**Load Time Target**: <2s  

**Sections**:

#### A. System Status (Top Bar)
```
┌─────────────────────────────────────────────────────┐
│ Bot-Nation Dashboard                 🟢 All Systems  │
├─────────────────────────────────────────────────────┤
│ ✓ Worker: 99.9% uptime    │ ✓ D1: operational     │
│ ✓ Microservices: all up   │ ✓ Telegram: connected │
│ • Last check: 2 min ago                            │
└─────────────────────────────────────────────────────┘
```

#### B. KPI Cards (4 cards)
```
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Active Users │ │   MAU Trend  │ │   Win Rate   │ │   Uptime     │
│     234      │ │   ↑ +12%     │ │    55.2%     │ │   99.92%     │
│              │ │ (vs last week)│ │ (vs 56%)     │ │ (43m down)   │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

#### C. Recent Activity Feed
```
Timeline of recent events:
- 14:32 - New skill created: "Sentiment Detection"
- 14:28 - Trading signal published: BUY TSLA (consensus 4/4)
- 14:15 - User "john" joined
- 14:03 - Skill refined: "Technical Breakout" (+0.05)
- 13:47 - Microservice health check passed
```

#### D. Quick Actions
```
[Launch New Skill] [View Trading Signals] [Check Agent Status] [Settings]
```

---

### 2. Trading Signals Page

**Purpose**: Real-time trading recommendations from multi-agent consensus  
**Access**: team-finance, traders  
**Refresh**: Real-time (WebSocket) or 5-min polling  

**Layout**:

#### A. Filters & Search
```
┌─────────────────────────────────────────────────────┐
│ Search or add ticker... [🔍]                        │
│ Filter: [All ▼] [Sector ▼] [Win Rate ↓] [Time ▼]  │
└─────────────────────────────────────────────────────┘
```

#### B. Signal Table
```
┌──────────┬──────────┬───────────┬─────────┬────────┬──────────────┐
│ Symbol   │ Signal   │ Agents    │ Conf.   │ Entry  │ Updated      │
├──────────┼──────────┼───────────┼─────────┼────────┼──────────────┤
│ TSLA ▲   │ BUY ⬆    │ 🟢🟢🟢🟢 | 78%     │ $175   │ 14:32 (2m)   │
│ SPY ▼    │ HOLD →   │ 🟢🟢🟡🟢 | 65%     │ $450   │ 14:28 (6m)   │
│ BTC ▲    │ BUY ⬆    │ 🟢🟢🟢🟢 | 82%     │ $42k   │ 14:15 (17m)  │
│ ETH ▼    │ SELL ⬇   │ 🟡🟢🟡🟡 | 52%     │ $2.3k  │ 13:47 (45m)  │
└──────────┴──────────┴───────────┴─────────┴────────┴──────────────┘

Legend:
🟢 = Agent agrees   🟡 = Agent weak   ⬆ = Bullish   ⬇ = Bearish   → = Neutral
```

#### C. Signal Detail Modal (Click on row)
```
┌──────────────────────────────────────────┐
│ TSLA Analysis                          [X]│
├──────────────────────────────────────────┤
│ Recommendation: BUY                       │
│ Confidence: 78% | Consensus: 4/4 agents  │
│                                          │
│ ANALYSIS BY AGENT:                       │
│                                          │
│ 🟢 Fundamental (92%)                     │
│   • EPS growth: 12% YoY                  │
│   • P/E ratio: 18.5 (fair)               │
│   • Cash flow: strong ($8.2B)            │
│   → RATING: BUY                          │
│                                          │
│ 🟢 Sentiment (85%)                       │
│   • Social media: +65% bullish           │
│   • Institutional: buying pressure       │
│   • Whale movements: accumulating        │
│   → SIGNAL: BUY                          │
│                                          │
│ 🟢 Technical (78%)                       │
│   • Price: breaking 200-day MA           │
│   • RSI: 65 (room to run)                │
│   • Volume: +40% above average           │
│   → SIGNAL: BREAKOUT CONFIRMATION        │
│                                          │
│ 🟢 Risk (72%)                            │
│   • Concentration: 8% portfolio          │
│   • Volatility: 28% annualized           │
│   • Suggested position size: 2% risk     │
│   → RECOMMENDATION: ACCEPTABLE RISK      │
│                                          │
│ [Copy Signal] [Share] [Trade] [Feedback]│
└──────────────────────────────────────────┘
```

---

### 3. Skill Library Page

**Purpose**: Browse and manage bot-nation's learned skills  
**Access**: All users (view), team-research (manage)  
**Features**: Search, filter by quality, sort by usage  

**Layout**:

#### A. Search & Filters
```
┌──────────────────────────────────────────────────┐
│ Search skills...                          [🔍]   │
│ Filter: [Quality ▼] [Category ▼] [Recent ▼]   │
│ Sort by: [Quality ↓] [Usage ↓] [Date ↓]       │
└──────────────────────────────────────────────────┘
```

#### B. Skill Cards Grid
```
┌─────────────────────┐ ┌─────────────────────┐
│ Technical Breakout  │ │ Trading Confluence  │
│ Trigger: breakout   │ │ Trigger: confluence │
│                     │ │                     │
│ Quality: ★★★★★ 0.82 │ │ Quality: ★★★☆☆ 0.68 │
│ Used: 5x this week  │ │ Used: 2x this week  │
│                     │ │                     │
│ Steps: 6            │ │ Steps: 4            │
│ Last refined: 1d    │ │ Last refined: 4d    │
│                     │ │                     │
│ [View] [Refine]     │ │ [View] [Refine]     │
└─────────────────────┘ └─────────────────────┘
```

#### C. Skill Detail View (Click on card)
```
┌──────────────────────────────────────────────┐
│ Technical Breakout Detection               [X]│
├──────────────────────────────────────────────┤
│                                              │
│ Quality Score: ★★★★★ 0.82                    │
│ Usage: 5 times this week ↗ +2 from last week│
│                                              │
│ TRIGGER PATTERN:                             │
│ breakout|bullish|above.*ma|price.*action    │
│                                              │
│ PROCEDURE:                                   │
│ 1. Check if price breaks 200-day MA         │
│ 2. Confirm RSI <70 (room to run)            │
│ 3. Check volume (>20-day avg by 50%+)       │
│ 4. Identify support level below entry       │
│ 5. Set stop loss 2-3% below support         │
│ 6. Risk/reward ratio should be 1:3 minimum  │
│                                              │
│ REFINEMENT HISTORY:                          │
│ • 2024-01-15: Added volume confirmation     │
│   (quality: 0.72 → 0.82, +0.10)             │
│ • 2024-01-10: Simplified MA calculation     │
│   (quality: 0.68 → 0.72, +0.04)             │
│                                              │
│ [Edit Procedure] [Refine] [Archive] [Share] │
└──────────────────────────────────────────────┘
```

---

### 4. Agent Status Page

**Purpose**: Monitor all 16 agents and their activities  
**Access**: team-leads, administrators  
**Refresh**: Real-time or 1-min polling  

**Layout**:

#### A. Department Overview (Tabs)
```
[All Teams] [Research] [Build] [Finance] [Growth] [Intel] [Real Estate] [DeFi]
```

#### B. Agent Status Grid
```
TEAM-FINANCE:
┌─────────────────────┬─────────────────────┬──────────────────┐
│ Fundamental         │ Sentiment           │ Technical        │
│ 🟢 Active           │ 🟢 Active           │ 🟢 Active        │
│ Last task: 10m ago  │ Last task: 3m ago   │ Last task: 1m ago│
│ Tasks today: 8      │ Tasks today: 12     │ Tasks today: 10  │
│ Success rate: 92%   │ Success rate: 88%   │ Success rate: 95%│
└─────────────────────┴─────────────────────┴──────────────────┘

┌──────────────────────────────────┐
│ Risk Manager                      │
│ 🟢 Active                         │
│ Last task: 5m ago                │
│ Tasks today: 6                   │
│ Success rate: 85%                │
└──────────────────────────────────┘
```

#### C. Agent Detail Modal (Click on agent)
```
┌────────────────────────────────────┐
│ Fundamental Analyst              [X]│
├────────────────────────────────────┤
│ Status: 🟢 Active                  │
│ Team: team-finance                 │
│ Department: dept-defi              │
│                                    │
│ ACTIVITY:                          │
│ • Tasks completed today: 8         │
│ • Success rate: 92%                │
│ • Avg response time: 2.3s          │
│ • Last active: 10m ago             │
│                                    │
│ RECENT TASKS:                      │
│ 1. Analyze TSLA fundamentals       │
│    ✓ Completed 14:32               │
│    Result: Rating BUY (PE: 18.5)   │
│                                    │
│ 2. Analyze SPY fundamentals        │
│    ✓ Completed 14:28               │
│    Result: Rating HOLD             │
│                                    │
│ 3. Analyze BTC fundamentals        │
│    ⏳ In progress (2m)             │
│                                    │
│ SKILLS CREATED:                    │
│ • Fundamental Valuation (0.65)     │
│ • PE Ratio Analysis (0.72)         │
│                                    │
│ [View Tasks] [Create Task] [Edit]  │
└────────────────────────────────────┘
```

---

### 5. System Health Page

**Purpose**: Monitor infrastructure and microservices  
**Access**: team-infra, administrators  
**Refresh**: Real-time (1-min intervals)  

**Layout**:

#### A. Overall Status
```
┌──────────────────────────────────────────┐
│ System Status: 🟢 HEALTHY                │
│ Uptime: 99.92% (43m downtime all Q1)     │
│ Response Time (p95): 1.8s                │
└──────────────────────────────────────────┘
```

#### B. Service Status Table
```
┌──────────────────┬─────────┬──────────┬───────────┬────────┐
│ Service          │ Status  │ Response │ Requests  │ Errors │
├──────────────────┼─────────┼──────────┼───────────┼────────┤
│ Worker           │ 🟢 Up   │ 23ms     │ 12,543/h  │ 0.01%  │
│ D1 Database      │ 🟢 Up   │ 47ms     │ 8,920/h   │ 0.00%  │
│ last30days-api   │ 🟢 Up   │ 3.2s     │ 1,200/h   │ 0.05%  │
│ hermes-api       │ 🟢 Up   │ 5.1s     │ 850/h     │ 0.02%  │
│ autoresearchclaw │ 🟢 Up   │ 18.5s    │ 320/h     │ 0.08%  │
│ tradingagents-api│ 🟢 Up   │ 2.8s     │ 2,100/h   │ 0.03%  │
└──────────────────┴─────────┴──────────┴───────────┴────────┘
```

#### C. Resource Usage
```
┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│   Worker    │ │  D1 Storage │ │   CPU (p95) │ │  Memory (p95)│
│   CPU: 12%  │ │   1.2GB/50GB│ │   34%       │ │   256MB/512MB│
│   Mem: 48%  │ │   Queries:  │ │   Trending: │ │   Trending:  │
│             │ │   425k/day  │ │   Stable ➡  │ │   Stable ➡   │
└─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘
```

#### D. Incident Timeline
```
Recent Incidents:
□ None in last 7 days  ✓ 99.92% uptime achieved

Last incident: 2024-01-10 (microservice restart, 5 min)
```

---

### 6. Settings Page

**Purpose**: User settings, API keys, notifications  
**Access**: All users (own settings), admins (global settings)  

**Sections**:

```
[Profile] [Notifications] [API Keys] [Preferences]

PROFILE:
□ Name: john_trader
□ Email: john@example.com
□ Telegram: @john_trader
[Edit] [Change Password]

NOTIFICATIONS:
☑ Trading signals
☑ System alerts
☑ Skill updates
☑ Daily digest
○ Email ○ Telegram ○ SMS
[Save]

API KEYS:
Your API keys (rotate every 90 days):
•••••••••••••••••••••••••••••••••• [Copy] [Regenerate]
[Show] [Hide]

PREFERENCES:
□ Dark mode
□ 24-hour clock
□ Compact view
□ Market: [US Equities ▼]
[Save]
```

---

## Design System

### Color Palette

| Element | Color | Hex |
|---------|-------|-----|
| Primary | Blue | #0066FF |
| Success | Green | #00CC66 |
| Warning | Orange | #FF9900 |
| Danger | Red | #FF3333 |
| Neutral | Gray | #666666 |
| Background | Dark | #0A0E27 |
| Text | Light | #E0E0E0 |

### Typography

```
Headings: Inter Bold (24px, 20px, 16px)
Body: Inter Regular (14px)
Monospace: Courier (12px, for code/data)
```

### Component Library

- **Buttons**: Primary (blue), Secondary (gray), Danger (red)
- **Cards**: 4px radius, subtle shadow
- **Tables**: Striped rows, hover highlight
- **Modals**: 80% viewport, centered
- **Charts**: Line, bar, candlestick (TradingView Lightweight Charts)
- **Alerts**: Toast notifications (top-right)

---

## Technical Requirements

### Frontend Stack

| Component | Technology | Notes |
|-----------|-----------|-------|
| Framework | React 18+ | TypeScript |
| Styling | Tailwind CSS + Radix UI | Component library |
| State | TanStack Query + Zustand | Server + client state |
| Charts | TradingView Charts | Lightweight, fast |
| Real-time | Socket.io or WebSocket | Live signal updates |
| Build | Vite | Fast bundling |
| Hosting | Cloudflare Pages | Same origin as worker |

### Backend API Endpoints (To Be Built)

```
GET /api/dashboard/overview       → KPI metrics
GET /api/signals                  → Trading signals (paginated)
GET /api/signals/{symbol}         → Signal details
GET /api/skills                   → Skill library (paginated)
GET /api/skills/{skillId}         → Skill details
GET /api/agents                   → Agent status
GET /api/agents/{agentId}         → Agent details
GET /api/health                   → System health
GET /api/metrics                  → System metrics (time series)
POST /api/feedback                → Submit user feedback
POST /api/signals/{signalId}/trade → Execute trade (future)
```

### Performance Targets

| Page | Load Time | Interactive | 1st Paint |
|------|-----------|-----------|-----------|
| Home | <2s | <3s | <1s |
| Signals | <2s | <3s | <1s |
| Skills | <2s | <4s | <1s |
| Agents | <2s | <3s | <1s |
| Health | <1s | <2s | <0.5s |

---

## Deployment

**URL**: https://dashboard.bot-nation.com (or worker route)  
**Hosting**: Cloudflare Pages (static) + Workers (API)  
**Build Process**: Automated via GitHub Actions  

```bash
# Build frontend
npm run build

# Deploy to Cloudflare Pages
npx wrangler pages deploy dist/

# API routes proxied through worker
```

---

## Roadmap

### v0.1 (MVP - Week 9)
- [ ] Home dashboard (basic KPIs)
- [ ] Trading signals table (read-only)
- [ ] Skill library (searchable)
- [ ] System health (basic monitoring)

### v0.2 (Enhancement - Week 13)
- [ ] Real-time updates (WebSocket)
- [ ] Signal detail modals
- [ ] Skill refinement UI
- [ ] Agent status page

### v1.0 (Production - Q2)
- [ ] Advanced charting (TradingView integration)
- [ ] Backtesting simulator
- [ ] Portfolio tracker
- [ ] Advanced analytics

---

**Document Version**: 1.0  
**Created**: 2024-01-15  
**Next Update**: 2024-02-01 (MVP launch planning)
