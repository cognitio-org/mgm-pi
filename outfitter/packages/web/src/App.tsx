import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { api } from "./api/client.ts";
import { ProviderStrip } from "./components/ProviderStrip.tsx";
import { Logo } from "./components/Logo.tsx";
import { ThemeToggle } from "./components/ThemeToggle.tsx";
import { SoundToggle } from "./components/SoundToggle.tsx";
import { FleetPage } from "./pages/FleetPage.tsx";
import { SessionPage } from "./pages/SessionPage.tsx";
import { ProvidersPage } from "./pages/ProvidersPage.tsx";
import { TokensPage } from "./pages/TokensPage.tsx";
import { GurusPage } from "./pages/GurusPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";

export function App() {
  // The Settings nav link only shows for an operator (EPIC.md Decisions table); GET /api/me is
  // the source of truth, so this fetches once on mount rather than guessing from any local state.
  const [operator, setOperator] = useState(false);
  useEffect(() => {
    api
      .me()
      .then((me) => setOperator(!!me.operator))
      .catch(() => setOperator(false));
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <NavLink to="/" aria-label="Outfitter home" style={{ textDecoration: "none" }}>
          <Logo />
        </NavLink>
        <nav>
          <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>
            Fleet
          </NavLink>
          <NavLink to="/gurus" className={({ isActive }) => (isActive ? "active" : "")}>
            Gurus
          </NavLink>
          <NavLink to="/providers" className={({ isActive }) => (isActive ? "active" : "")}>
            Providers
          </NavLink>
          <NavLink to="/tokens" className={({ isActive }) => (isActive ? "active" : "")}>
            Tokens
          </NavLink>
          {operator && (
            <NavLink to="/settings" className={({ isActive }) => (isActive ? "active" : "")}>
              Settings
            </NavLink>
          )}
        </nav>
        <div className="app-header-spacer">
          <ProviderStrip />
          <SoundToggle />
          <ThemeToggle />
        </div>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<FleetPage />} />
          <Route path="/sessions/:id" element={<SessionPage />} />
          <Route path="/gurus" element={<GurusPage />} />
          <Route path="/providers" element={<ProvidersPage />} />
          <Route path="/tokens" element={<TokensPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
