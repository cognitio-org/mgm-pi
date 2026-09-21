import { NavLink, Route, Routes } from "react-router-dom";
import { ProviderStrip } from "./components/ProviderStrip.tsx";
import { FleetPage } from "./pages/FleetPage.tsx";
import { SessionPage } from "./pages/SessionPage.tsx";
import { ProvidersPage } from "./pages/ProvidersPage.tsx";
import { TokensPage } from "./pages/TokensPage.tsx";

export function App() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <strong>Outfitter</strong>
        <nav>
          <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>
            Fleet
          </NavLink>
          <NavLink to="/providers" className={({ isActive }) => (isActive ? "active" : "")}>
            Providers
          </NavLink>
          <NavLink to="/tokens" className={({ isActive }) => (isActive ? "active" : "")}>
            Tokens
          </NavLink>
        </nav>
        <ProviderStrip />
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<FleetPage />} />
          <Route path="/sessions/:id" element={<SessionPage />} />
          <Route path="/providers" element={<ProvidersPage />} />
          <Route path="/tokens" element={<TokensPage />} />
        </Routes>
      </main>
    </div>
  );
}
