import { Suspense, lazy, useEffect, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api } from "./api/client.ts";
import { ProviderStrip } from "./components/ProviderStrip.tsx";
import { Logo } from "./components/Logo.tsx";
import { ThemeToggle } from "./components/ThemeToggle.tsx";
import { SoundToggle } from "./components/SoundToggle.tsx";
import { DeskPage } from "./pages/DeskPage.tsx";
import { FleetPage } from "./pages/FleetPage.tsx";
import { ProvidersPage } from "./pages/ProvidersPage.tsx";
import { TokensPage } from "./pages/TokensPage.tsx";
import { vocabulary } from "./lib/vocabulary.ts";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { Working } from "./components/Working.tsx";
import { UnhandledRejectionBanner } from "./components/UnhandledRejectionBanner.tsx";
import { NotFoundError } from "./components/NotFoundError.tsx";
import { DeviceNotPresent } from "./components/DeviceNotPresent.tsx";
import { useOnlineStatus } from "./hooks/useOnlineStatus.ts";
import { EasterEggPage } from "./easter/EasterEggPage.tsx";
import { useKonamiCode } from "./easter/useKonamiCode.ts";
import { openEasterEgg } from "./easter/openEasterEgg.tsx";

/** Throws on render, gated to dev builds only -- lets `/panic-test` drive a screenshot of the
 * KERNAL PANIC screen without shipping a way for anyone else to trigger it. */
function PanicTest(): never {
  throw new Error("Manually triggered via /panic-test (dev-only route).");
}


// Code-split: the heavier pages (markdown rendering, the tour animation, the forms) load when
// first opened, so the desk and the Disk Box stay small (review of round five).
const SessionPage = lazy(() => import("./pages/SessionPage.tsx").then((m) => ({ default: m.SessionPage })));
const GurusPage = lazy(() => import("./pages/GurusPage.tsx").then((m) => ({ default: m.GurusPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage.tsx").then((m) => ({ default: m.SettingsPage })));
const ManualPage = lazy(() => import("./pages/ManualPage.tsx").then((m) => ({ default: m.ManualPage })));

const PANIC_TEST_ENABLED = Boolean(import.meta.env.DEV || import.meta.env.OUTFITTER_DEV);

const NAV_ITEMS: Array<{ to: string; end?: boolean; label: string; hint: string; operatorOnly?: boolean }> = [
  { to: "/", end: true, label: vocabulary.desk.one, hint: "the Outfitter desktop" },
  { to: "/fleet", label: vocabulary.sessionList.one, hint: vocabulary.sessionList.hint },
  { to: "/gurus", label: vocabulary.guru.many, hint: vocabulary.guru.hint },
  { to: "/providers", label: vocabulary.provider.many, hint: vocabulary.provider.hint },
  { to: "/tokens", label: vocabulary.token.many, hint: vocabulary.token.hint },
  { to: "/settings", label: vocabulary.settings.one, hint: `${vocabulary.settings.hint} — ${vocabulary.operator.hint}`, operatorOnly: true },
];

export function App() {
  // The Settings/Control Panel nav link only shows for an operator/Sysop (EPIC.md Decisions
  // table); GET /api/me is the source of truth, so this fetches once on mount rather than
  // guessing from any local state.
  const [operator, setOperator] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const isDesk = location.pathname === "/";
  const online = useOnlineStatus();
  useEffect(() => {
    api
      .me()
      .then((me) => setOperator(!!me.operator))
      .catch(() => setOperator(false));
  }, []);

  // Konami code, anywhere outside a form field -- see docs/easter for why this trigger was
  // picked. openEasterEgg() dynamic-imports the whole game, so this costs nothing until typed.
  useKonamiCode(openEasterEgg);

  const items = NAV_ITEMS.filter((item) => !item.operatorOnly || operator);

  return (
    <div className="app-shell">
      {/* On the desk (/), the desk's own GEOS-style menu bar (DeskPage.tsx) replaces this header
       * on desktop widths -- having both stacked ~160px of chrome duplicating the same nav was
       * the original bug report. On phones this header's compact bar (logo + summary pill + menu
       * button) still renders regardless of route, since the desk's menu bar collapses into the
       * icon grid there and has no room for its own top bar too. */}
      <header className={`app-header${isDesk ? " app-header-desk" : ""}`}>
        <NavLink to="/" aria-label="Outfitter desk" style={{ textDecoration: "none" }} title={vocabulary.desk.hint}>
          <Logo />
        </NavLink>
        <nav className="app-nav-desktop">
          {items.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} title={item.hint} className={({ isActive }) => (isActive ? "active" : "")}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="app-header-spacer">
          <ProviderStrip />
          <SoundToggle compact />
          <ThemeToggle compact />
        </div>
        <button
          type="button"
          className="app-menu-button"
          aria-label="Menu"
          aria-expanded={menuOpen}
          aria-haspopup="true"
          onClick={() => setMenuOpen((v) => !v)}
        >
          {"☰"}
        </button>
      </header>

      {menuOpen && (
        <div className="app-menu-backdrop" onClick={() => setMenuOpen(false)}>
          <nav className="app-menu-sheet" onClick={(e) => e.stopPropagation()} aria-label="Navigation">
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                title={item.hint}
                className={({ isActive }) => (isActive ? "active" : "")}
                onClick={() => setMenuOpen(false)}
              >
                {item.label}
              </NavLink>
            ))}
            <div className="app-menu-sheet-controls">
              <SoundToggle />
              <ThemeToggle />
            </div>
          </nav>
        </div>
      )}

      {!online && (
        <div className="app-offline-banner">
          <DeviceNotPresent
            reason="you're offline — changes won't reach Outfitter until the connection comes back."
          />
        </div>
      )}
      <UnhandledRejectionBanner />

      <main className="app-main">
        <ErrorBoundary>
          <Suspense fallback={<div className="page-loading"><Working label="Loading" size="lg" /></div>}>
          <Routes>
            <Route path="/" element={<DeskPage />} />
            <Route path="/fleet" element={<FleetPage />} />
            <Route path="/sessions/:id" element={<SessionPage />} />
            <Route path="/gurus" element={<GurusPage />} />
            <Route path="/providers" element={<ProvidersPage />} />
            <Route path="/tokens" element={<TokensPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            {PANIC_TEST_ENABLED && <Route path="/panic-test" element={<PanicTest />} />}
            <Route path="/manual" element={<ManualPage />} />
            <Route path="/ready" element={<EasterEggPage />} />
            <Route path="*" element={<NotFoundError subject="This page" />} />
          </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}
