import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useNavigate } from "react-router-dom";
import { api, type ProviderRow, type SessionSummary } from "../api/client.ts";
import { deriveDeskStatus, moveGridFocus, stoppedSessionCount, type GridKey } from "../lib/desk.ts";
import { vocabulary } from "../lib/vocabulary.ts";
import { Logo, LogoMark } from "../components/Logo.tsx";
import { NewSessionDialog } from "../components/NewSessionDialog.tsx";
import { ProviderStrip } from "../components/ProviderStrip.tsx";
import { SoundToggle } from "../components/SoundToggle.tsx";
import { ThemeToggle } from "../components/ThemeToggle.tsx";
import {
  ControlPanelIcon,
  DiskBoxIcon,
  DonglesIcon,
  DriveIcon,
  ManualIcon,
  NewFloppyIcon,
  PeripheralsIcon,
  TapesIcon,
  TrashIcon,
} from "../components/DeskIcons.tsx";

const GRID_KEYS: GridKey[] = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"];

interface DeskIconDef {
  id: string;
  label: string;
  hint: string;
  icon: (size: number) => ReactElement;
  onOpen: () => void;
}

/** The GEOS-deskTop-styled home page: a menu bar, one window with the icon grid, and two desktop
 * icons (Drive/Trash) outside it -- see docs/reports/mobile-desk.md for the design rationale. The
 * session list itself lives at /fleet; this page never lists sessions, only counts them. */
export function DeskPage() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [operator, setOperator] = useState(false);
  const [showNewSession, setShowNewSession] = useState(false);
  const [gurus, setGurus] = useState<Awaited<ReturnType<typeof api.gurus>>>([]);
  const [showManual, setShowManual] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [focused, setFocused] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    Promise.all([api.sessions(), api.providers(), api.gurus(), api.me()])
      .then(([s, p, g, me]) => {
        setSessions(s);
        setProviders(p);
        setGurus(g);
        setOperator(!!me.operator);
      })
      .catch(() => {
        // Desk still renders (all-zero status) if any of these fail -- it's a launcher, not the
        // source of truth, and each destination page has its own error handling.
      });
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const status = useMemo(() => deriveDeskStatus(sessions, providers, now), [sessions, providers, now]);
  const stoppedCount = useMemo(() => stoppedSessionCount(sessions), [sessions]);

  const icons: DeskIconDef[] = useMemo(() => {
    const list: DeskIconDef[] = [
      {
        id: "diskbox",
        label: vocabulary.sessionList.one,
        hint: vocabulary.sessionList.hint,
        icon: (size) => <DiskBoxIcon size={size} />,
        onOpen: () => navigate("/fleet"),
      },
      {
        id: "newfloppy",
        label: vocabulary.newSession.one,
        hint: vocabulary.newSession.hint,
        icon: (size) => <NewFloppyIcon size={size} />,
        onOpen: () => setShowNewSession(true),
      },
      {
        id: "tapes",
        label: vocabulary.guru.many,
        hint: vocabulary.guru.hint,
        icon: (size) => <TapesIcon size={size} />,
        onOpen: () => navigate("/gurus"),
      },
      {
        id: "peripherals",
        label: vocabulary.provider.many,
        hint: vocabulary.provider.hint,
        icon: (size) => <PeripheralsIcon size={size} />,
        onOpen: () => navigate("/providers"),
      },
      {
        id: "dongles",
        label: vocabulary.token.many,
        hint: vocabulary.token.hint,
        icon: (size) => <DonglesIcon size={size} />,
        onOpen: () => navigate("/tokens"),
      },
    ];
    if (operator) {
      list.push({
        id: "controlpanel",
        label: vocabulary.settings.one,
        hint: `${vocabulary.settings.hint} — ${vocabulary.operator.hint}`,
        icon: (size) => <ControlPanelIcon size={size} />,
        onOpen: () => navigate("/settings"),
      });
    }
    list.push({
      id: "manual",
      label: vocabulary.help.one,
      hint: vocabulary.help.hint,
      icon: (size) => <ManualIcon size={size} />,
      onOpen: () => setShowManual(true),
    });
    return list;
  }, [operator, navigate]);

  function handleGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!GRID_KEYS.includes(e.key as GridKey)) return;
    e.preventDefault();
    const cols = gridCols();
    const next = moveGridFocus(focused, e.key as GridKey, icons.length, cols);
    setFocused(next);
    const btn = gridRef.current?.querySelectorAll<HTMLButtonElement>("[data-desk-icon]")[next];
    btn?.focus();
  }

  function gridCols(): number {
    // Matches the CSS grid: 4 columns on desktop, 3 on phones (see styles/layout.css's
    // .desk-icon-grid media query) -- read the actual computed column count so keyboard nav
    // tracks the visual layout instead of assuming one width.
    const el = gridRef.current;
    if (!el) return 4;
    const style = window.getComputedStyle(el);
    const template = style.gridTemplateColumns;
    if (!template) return 4;
    return template.split(" ").filter(Boolean).length || 4;
  }

  function openMenuOrToggle(name: string) {
    setOpenMenu((m) => (m === name ? null : name));
  }

  return (
    <div className="desk" onClick={() => setOpenMenu(null)}>
      <div className="desk-menubar" role="menubar">
        <div className="desk-menu">
          <button
            type="button"
            className="desk-menu-trigger desk-menu-logo"
            aria-haspopup="menu"
            aria-expanded={openMenu === "logo"}
            onClick={(e) => {
              e.stopPropagation();
              openMenuOrToggle("logo");
            }}
            title="Outfitter"
          >
            <LogoMark size={16} />
          </button>
          {openMenu === "logo" && (
            <ul className="desk-menu-list" role="menu">
              <li role="menuitem">
                <button type="button" onClick={() => setShowManual(true)}>
                  {vocabulary.help.one}: About Outfitter
                </button>
              </li>
            </ul>
          )}
        </div>
        <div className="desk-menu">
          <button
            type="button"
            className="desk-menu-trigger"
            aria-haspopup="menu"
            aria-expanded={openMenu === "session"}
            onClick={(e) => {
              e.stopPropagation();
              openMenuOrToggle("session");
            }}
          >
            Session
          </button>
          {openMenu === "session" && (
            <ul className="desk-menu-list" role="menu">
              <li role="menuitem">
                <button
                  type="button"
                  onClick={() => {
                    setOpenMenu(null);
                    setShowNewSession(true);
                  }}
                >
                  {vocabulary.newSession.one}
                </button>
              </li>
              <li role="menuitem">
                <button type="button" onClick={() => navigate("/fleet")}>
                  {vocabulary.sessionList.one}
                </button>
              </li>
            </ul>
          )}
        </div>
        <div className="desk-menu">
          <button
            type="button"
            className="desk-menu-trigger"
            aria-haspopup="menu"
            aria-expanded={openMenu === "view"}
            onClick={(e) => {
              e.stopPropagation();
              openMenuOrToggle("view");
            }}
          >
            View
          </button>
          {openMenu === "view" && (
            <ul className="desk-menu-list" role="menu">
              <li role="menuitem">
                <button type="button" onClick={() => navigate("/gurus")}>
                  {vocabulary.guru.many}
                </button>
              </li>
              <li role="menuitem">
                <button type="button" onClick={() => navigate("/providers")}>
                  {vocabulary.provider.many}
                </button>
              </li>
              <li role="menuitem">
                <button type="button" onClick={() => navigate("/tokens")}>
                  {vocabulary.token.many}
                </button>
              </li>
              {operator && (
                <li role="menuitem">
                  <button type="button" onClick={() => navigate("/settings")}>
                    {vocabulary.settings.one}
                  </button>
                </li>
              )}
            </ul>
          )}
        </div>
        <div className="desk-menubar-spacer">
          <ProviderStrip />
          <SoundToggle compact />
          <ThemeToggle compact />
        </div>
        <div className="desk-clock" aria-label="Current time">
          {now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
      </div>

      <div className="desk-surface">
        <div className="panel desk-window">
          <div className="panel-titlebar desk-window-titlebar">
            <span className="desk-window-close" aria-hidden="true" />
            <span className="panel-label">{vocabulary.desk.one}</span>
          </div>
          <div className="desk-statusbar">
            {vocabulary.sessionList.one}: {status.sessionCount} &middot; Running: {status.runningCount} &middot;
            Today: ${status.todaysCost.toFixed(2)} &middot; {vocabulary.provider.many}: {status.providersUp}/
            {status.providersTotal} up
          </div>
          <div
            className="desk-icon-grid"
            role="grid"
            aria-label="Outfitter applications"
            ref={gridRef}
            onKeyDown={handleGridKeyDown}
          >
            {icons.map((icon, i) => (
              <button
                key={icon.id}
                type="button"
                data-desk-icon
                className="desk-icon"
                tabIndex={i === focused ? 0 : -1}
                title={`${icon.label} — ${icon.hint}`}
                onFocus={() => setFocused(i)}
                onClick={(e) => {
                  e.stopPropagation();
                  icon.onOpen();
                }}
              >
                {icon.icon(32)}
                <span className="desk-icon-label">{icon.label}</span>
              </button>
            ))}
          </div>
          <span className="desk-window-corner" aria-hidden="true" />
        </div>

        <div className="desk-desktop-icons">
          <button
            type="button"
            className="desk-desktop-icon desk-desktop-icon-drive"
            onClick={(e) => {
              e.stopPropagation();
              navigate("/providers");
            }}
            title={`${vocabulary.drive.many} — ${status.runningCount} running`}
          >
            <DriveIcon size={30} />
            <span className="desk-icon-label">
              {vocabulary.drive.many} ({status.runningCount})
            </span>
          </button>

          <button
            type="button"
            className="desk-desktop-icon desk-desktop-icon-trash"
            onClick={(e) => {
              e.stopPropagation();
              navigate("/fleet?runState=stopped");
            }}
            title={`${vocabulary.trash.one} — ${stoppedCount} stopped ${vocabulary.session.many.toLowerCase()}`}
          >
            <TrashIcon size={30} />
            <span className="desk-icon-label">
              {vocabulary.trash.one} ({stoppedCount})
            </span>
          </button>
        </div>
      </div>

      {showNewSession && (
        <NewSessionDialog
          gurus={gurus}
          onClose={() => setShowNewSession(false)}
          onCreated={(id) => {
            setShowNewSession(false);
            navigate(`/sessions/${id}`);
          }}
        />
      )}

      {showManual && (
        <div className="dialog-backdrop" onClick={() => setShowManual(false)}>
          <div
            className="dialog panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="manual-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="panel-titlebar">
              <span className="panel-label" id="manual-title">
                {vocabulary.help.one}
              </span>
            </div>
            <div className="panel-body desk-manual">
              <Logo size={28} />
              <p>
                Outfitter equips a fleet of cloud coding agents (Tapes) the way an outfitter equips an
                expedition. This is the Desk &mdash; open a Tape to start a new Floppy, or the Disk Box to see
                every floppy you've run.
              </p>
              <p>
                {vocabulary.kernal.one} loads your floppies and runs your tapes; Outfitter is where they live.
              </p>
              <div className="form-actions">
                <button type="button" className="btn btn-primary" onClick={() => setShowManual(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
