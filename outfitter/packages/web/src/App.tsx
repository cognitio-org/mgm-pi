import { Suspense, useEffect, useRef, useState } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import { api, ApiError } from "./api/client.ts";
import { registerWebMcpTools } from "./lib/webmcp.ts";
import { ProviderStrip } from "./components/ProviderStrip.tsx";
import { Logo } from "./components/Logo.tsx";
import { ThemeToggle } from "./components/ThemeToggle.tsx";
import { SoundToggle } from "./components/SoundToggle.tsx";
import { DeskPage } from "./pages/DeskPage.tsx";
import { FleetPage } from "./pages/FleetPage.tsx";
import { ProvidersPage } from "./pages/ProvidersPage.tsx";
import { TokensPage } from "./pages/TokensPage.tsx";
import { vocabulary } from "./lib/vocabulary.ts";
import { lazyRoute } from "./lib/chunk-reload.ts";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { Working } from "./components/Working.tsx";
import { UnhandledRejectionBanner } from "./components/UnhandledRejectionBanner.tsx";
import { LaptopApprovals } from "./components/LaptopApprovals.tsx";
import { NotFoundError } from "./components/NotFoundError.tsx";
import { DeviceNotPresent } from "./components/DeviceNotPresent.tsx";
import { useOnlineStatus } from "./hooks/useOnlineStatus.ts";
import { useAppVersion, versionLabel } from "./hooks/useAppVersion.ts";
import { EasterEggPage } from "./easter/EasterEggPage.tsx";
import { useKonamiCode } from "./easter/useKonamiCode.ts";
import { useSysCommand } from "./easter/useSysCommand.ts";
import { openEasterEgg } from "./easter/openEasterEgg.tsx";
import { welcomeCookieAssignment, welcomeCookieClear } from "./lib/welcome-cookie.ts";

/** Throws on render, gated to dev builds only -- lets `/panic-test` drive a screenshot of the
 * KERNAL PANIC screen without shipping a way for anyone else to trigger it. */
function PanicTest(): never {
  throw new Error("Manually triggered via /panic-test (dev-only route).");
}


// Code-split: the heavier pages (markdown rendering, the tour animation, the forms) load when
// first opened, so the desk and the Disk Box stay small (review of round five).
const SessionPage = lazyRoute(() => import("./pages/SessionPage.tsx").then((m) => ({ default: m.SessionPage })));
const GurusPage = lazyRoute(() => import("./pages/GurusPage.tsx").then((m) => ({ default: m.GurusPage })));
const SettingsPage = lazyRoute(() => import("./pages/SettingsPage.tsx").then((m) => ({ default: m.SettingsPage })));
const ManualPage = lazyRoute(() => import("./pages/ManualPage.tsx").then((m) => ({ default: m.ManualPage })));
const GithubPage = lazyRoute(() => import("./pages/GithubPage.tsx").then((m) => ({ default: m.GithubPage })));
// #389 central sign-in and settings (docs/specs/central-auth.md §6-§7).
const DevicesPage = lazyRoute(() => import("./pages/DevicesPage.tsx").then((m) => ({ default: m.DevicesPage })));
const DeviceApprovePage = lazyRoute(() => import("./pages/DeviceApprovePage.tsx").then((m) => ({ default: m.DeviceApprovePage })));
const AccountPage = lazyRoute(() => import("./pages/AccountPage.tsx").then((m) => ({ default: m.AccountPage })));

const PANIC_TEST_ENABLED = Boolean(import.meta.env.DEV || import.meta.env.OUTFITTER_DEV);

const NAV_ITEMS: Array<{ to: string; end?: boolean; label: string; hint: string; operatorOnly?: boolean }> = [
  { to: "/", end: true, label: vocabulary.desk.one, hint: "the Outfitter desktop" },
  { to: "/fleet", label: vocabulary.sessionList.one, hint: vocabulary.sessionList.hint },
  { to: "/gurus", label: vocabulary.guru.many, hint: vocabulary.guru.hint },
  { to: "/github", label: vocabulary.github.one, hint: vocabulary.github.hint },
  { to: "/providers", label: vocabulary.provider.many, hint: vocabulary.provider.hint },
  { to: "/tokens", label: vocabulary.token.many, hint: vocabulary.token.hint },
  // #389: sysops only while the pages are placeholders; CA-1 web and CA-7 drop operatorOnly on their own line.
  { to: "/devices", label: vocabulary.device.many, hint: vocabulary.device.hint, operatorOnly: true },
  { to: "/account", label: vocabulary.account.one, hint: vocabulary.account.hint, operatorOnly: true },
  { to: "/settings", label: vocabulary.settings.one, hint: `${vocabulary.settings.hint} — ${vocabulary.operator.hint}`, operatorOnly: true },
];

export function App() {
  // The Settings/Control Panel nav link only shows for an operator/Sysop (EPIC.md Decisions
  // table); GET /api/me is the source of truth. Refetch on focus so a changed signed-in user
  // replaces the WebMCP tools (a transient error must not clear them; 401/403 does).
  const [operator, setOperator] = useState(false);
  const [signedInEmail, setSignedInEmail] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const isDesk = location.pathname === "/";
  const online = useOnlineStatus();
  useEffect(() => {
    let cancelled = false;
    let request = 0;
    function loadMe() {
      const id = ++request;
      api
        .me()
        .then((me) => {
          if (cancelled || id !== request) return;
          setOperator(!!me.operator);
          setSignedInEmail(me.email || null);
          const host = window.location.hostname;
          const secure = window.location.protocol === "https:";
          document.cookie = (me.name && welcomeCookieAssignment(me.name, host, secure)) || welcomeCookieClear(host, secure);
        })
        .catch((err) => {
          if (cancelled || id !== request) return;
          setOperator(false);
          // A blip must not drop tools that were registered for a still-signed-in user.
          // 401/403 means the page is no longer that user.
          if (err instanceof ApiError && (err.status === 401 || err.status === 403)) setSignedInEmail(null);
        });
    }
    loadMe();
    window.addEventListener("focus", loadMe);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", loadMe);
    };
  }, []);

  // Fleet tools for this signed-in user. No-ops without document.modelContext.registerTool.
  // A new email aborts the previous registration first (see registerWebMcpTools).
  useEffect(() => registerWebMcpTools(signedInEmail), [signedInEmail]);

  // Konami code, anywhere outside a form field -- see docs/easter for why this trigger was
  // picked. openEasterEgg() dynamic-imports the whole game, so this costs nothing until typed.
  useKonamiCode(openEasterEgg);
  // ...and the C64 reset command, `SYS 64738` + Enter, also anywhere outside a form field.
  useSysCommand(openEasterEgg);

  const items = NAV_ITEMS.filter((item) => !item.operatorOnly || operator);
  const headerRef = useRef<HTMLElement>(null);
  // Session chrome sticks just under this bar on phones. The height changes with wrapping and
  // the safe-area inset, so a fixed offset would leave a gap or cover the title.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const apply = () => {
      document.documentElement.style.setProperty("--app-header-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--app-header-h");
    };
  }, []);

  const { version, updated } = useAppVersion();
  const versionText = versionLabel(version);

  return (
    <div className="app-shell">
      {/* On the desk (/), the desk's own GEOS-style menu bar (DeskPage.tsx) replaces this header
       * on desktop widths -- having both stacked ~160px of chrome duplicating the same nav was
       * the original bug report. On phones this header's compact bar (logo + summary pill + menu
       * button) still renders regardless of route, since the desk's menu bar collapses into the
       * icon grid there and has no room for its own top bar too. */}
      <header ref={headerRef} className={`app-header${isDesk ? " app-header-desk" : ""}`}>
        <NavLink
          to="/"
          aria-label="Outfitter desk"
          style={{ textDecoration: "none" }}
          title={versionText ? `${vocabulary.desk.hint} · Outfitter ${versionText}` : vocabulary.desk.hint}
        >
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
            <button
              type="button"
              className="app-menu-sheet-item"
              title="KERNAL GAMES"
              aria-label="SYS 64738: open KERNAL GAMES"
              onClick={() => {
                setMenuOpen(false);
                void openEasterEgg();
              }}
            >
              SYS 64738
            </button>
            <div className="app-menu-sheet-controls">
              <SoundToggle />
              <ThemeToggle />
            </div>
            {versionText && <div className="app-version">Outfitter {versionText}</div>}
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
      {updated && (
        <div className="app-update-banner" role="status">
          Outfitter was updated{versionLabel(updated) ? ` to ${versionLabel(updated)}` : ""}. Reload to use the new version.
          <button type="button" className="btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
      <UnhandledRejectionBanner />
      <LaptopApprovals />

      <main className="app-main">
        <ErrorBoundary>
          <Suspense fallback={<div className="page-loading"><Working label="Loading" size="lg" /></div>}>
          <Routes>
            <Route path="/" element={<DeskPage />} />
            <Route path="/fleet" element={<FleetPage />} />
            <Route path="/sessions/:id" element={<SessionPage />} />
            <Route path="/gurus" element={<GurusPage />} />
            <Route path="/github" element={<GithubPage />} />
            <Route path="/providers" element={<ProvidersPage />} />
            <Route path="/tokens" element={<TokensPage />} />
            <Route path="/devices" element={<DevicesPage />} />
            <Route path="/device" element={<DeviceApprovePage />} />
            <Route path="/account" element={<AccountPage />} />
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
