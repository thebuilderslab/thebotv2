import { NavLink, Outlet, Route, Routes } from "react-router-dom";
import "./theme/styles.css";
import { NationOverview } from "./pages/NationOverview";
import { AgentsTeams } from "./pages/AgentsTeams";
import { Proposals } from "./pages/Proposals";
import { Runs } from "./pages/Runs";
import { Settings } from "./pages/Settings";

const NAV = [
  { to: "/", icon: "⬡", label: "Overview", end: true },
  { to: "/agents", icon: "◈", label: "Agents & Teams" },
  { to: "/proposals", icon: "◉", label: "Proposals" },
  { to: "/runs", icon: "▷", label: "Runs" },
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
          v0 · Phase 0
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
        <Route path="runs" element={<Runs />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  );
}
