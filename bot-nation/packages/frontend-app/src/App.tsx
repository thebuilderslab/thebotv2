import { NavLink, Outlet, Route, Routes } from "react-router-dom";
import "./theme/styles.css";
import { NationOverview } from "./pages/NationOverview";
import { AgentsTeams } from "./pages/AgentsTeams";
import { Proposals } from "./pages/Proposals";
import { ApprovalsInbox } from "./pages/ApprovalsInbox";
import { Runs } from "./pages/Runs";
import { EventLog } from "./pages/EventLog";
import { Artifacts } from "./pages/Artifacts";
import { GraphView } from "./pages/GraphView";
import { Settings } from "./pages/Settings";
import { AgentStream } from "./pages/AgentStream";

const NAV = [
  { to: "/", icon: "⬡", label: "Overview", end: true },
  { to: "/agents", icon: "◈", label: "Agents & Teams" },
  { to: "/proposals", icon: "◉", label: "Proposals" },
  { to: "/inbox", icon: "◎", label: "Approval Inbox" },
  { to: "/runs", icon: "▷", label: "Runs" },
  { to: "/events", icon: "≋", label: "Event Log" },
  { to: "/artifacts", icon: "◫", label: "Artifacts" },
  { to: "/graph", icon: "⬡", label: "Graph" },
  { to: "/stream", icon: "⟳", label: "Live Stream" },
  { to: "/settings", icon: "⚙", label: "Settings" },
];

function Layout() {
  return (
    <div className="layout">
      {/* Header */}
      <header className="header">
        <span className="header-logo">BOT-NATION / LAB CONSOLE</span>
        <div className="header-divider" />
        <span className="header-status">
          <span className="dot" />
          v0 · Phase 6
        </span>
      </header>

      {/* Sidebar */}
      <nav className="sidebar">
        <div className="nav-section">
          <div className="nav-label">Navigation</div>
          {NAV.map(({ to, icon, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `nav-item${isActive ? " active" : ""}`
              }
            >
              <span className="nav-icon">{icon}</span>
              {label}
            </NavLink>
          ))}
        </div>
      </nav>

      {/* Main */}
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<NationOverview />} />
        <Route path="agents" element={<AgentsTeams />} />
        <Route path="proposals" element={<Proposals />} />
        <Route path="inbox" element={<ApprovalsInbox />} />
        <Route path="runs" element={<Runs />} />
        <Route path="events" element={<EventLog />} />
        <Route path="artifacts" element={<Artifacts />} />
        <Route path="graph" element={<GraphView />} />
        <Route path="stream" element={<AgentStream />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
