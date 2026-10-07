import { useContext, useEffect, useRef, useState } from "react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { api, type Guru, type SessionSummary } from "../api/client.ts";
import { DISK_GROUPS, LAMP_WORD, groupDiskBox, rowMeta, shortWhen } from "../lib/disk-box.ts";
import { AppNavContext } from "../lib/nav.ts";
import { openEasterEgg } from "../easter/openEasterEgg.tsx";
import { floppyTitle, vocabulary } from "../lib/vocabulary.ts";
import { LogoMark } from "./Logo.tsx";
import { NewSessionDialog } from "./NewSessionDialog.tsx";
import { PopMenu } from "./PopMenu.tsx";
import { ProviderStrip } from "./ProviderStrip.tsx";
import { PlusIcon, SearchIcon, SideIcon } from "./SessionIcons.tsx";
import { SoundToggle } from "./SoundToggle.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";

/** How often the list is re-read while the tab is visible. */
export const DISK_BOX_POLL_MS = 15_000;

/**
 * #498: the Disk Box beside a floppy (docs/design/sessions-redesign-demo.html note 1). Every floppy
 * one click away, grouped Running / Today / Earlier, each with a lamp; search with ⌘K; New Floppy
 * opens the same dialog as the Disk Box page. On this route it stands in for the app bar, so its
 * footer carries the page links and the sound and theme toggles. The Archive is only a count here.
 */
export function DiskBoxSidebar({
  currentId,
  needsYou,
  refreshKey,
  onHide,
}: {
  currentId: string;
  /** The open floppy is waiting on a question (its stream knows; the list doesn't). */
  needsYou: boolean;
  /** Changes when the open floppy's state does, so its row catches up without waiting a poll. */
  refreshKey: string;
  onHide: () => void;
}) {
  const navigate = useNavigate();
  const navItems = useContext(AppNavContext);
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [archived, setArchived] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [gurus, setGurus] = useState<Guru[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .sessions()
        .then((rows) => !cancelled && setSessions(rows))
        .catch(() => !cancelled && setSessions((cur) => cur ?? []));
    // A hidden tab skips the poll, and catches up as soon as it's looked at again.
    const poll = () => {
      if (document.visibilityState !== "hidden") void load();
    };
    void load();
    const timer = setInterval(poll, DISK_BOX_POLL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [refreshKey]);

  useEffect(() => {
    let cancelled = false;
    api
      .sessions({ archived: "only" })
      .then((rows) => !cancelled && setArchived(rows.length))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // ⌘K / Ctrl+K: jump to the search box from anywhere on the page.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function openNew() {
    setNewOpen(true);
    api.gurus().then(setGurus).catch(() => setGurus([]));
  }

  const groups = groupDiskBox(sessions ?? [], { query, needsYouId: needsYou ? currentId : undefined });
  const shown = DISK_GROUPS.reduce((n, g) => n + groups[g].length, 0);

  return (
    <nav className="disk-box" aria-label={vocabulary.sessionList.one}>
      <div className="disk-box-head">
        <Link to="/" className="disk-box-logo" title={vocabulary.desk.hint}>
          <LogoMark size={20} />
          <span>OUTFITTER</span>
        </Link>
        <button type="button" className="icon-btn" onClick={onHide} aria-label="Hide the Disk Box" title="Hide the Disk Box">
          <SideIcon />
        </button>
      </div>
      <button type="button" className="disk-box-new" onClick={openNew} title={vocabulary.newSession.hint}>
        <PlusIcon />
        <span>{vocabulary.newSession.one}</span>
      </button>
      <label className="disk-box-search">
        <SearchIcon />
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && query) {
              e.stopPropagation();
              setQuery("");
            }
          }}
          placeholder="Search floppies  ⌘K"
          aria-label="Search floppies"
        />
      </label>
      <div className="disk-box-list">
        {sessions === null ? <p className="disk-box-empty">LOADING…</p> : null}
        {sessions !== null && shown === 0 ? <p className="disk-box-empty">{query ? "No floppies match." : "No floppies yet."}</p> : null}
        {DISK_GROUPS.map((group) =>
          groups[group].length === 0 ? null : (
            <section key={group} className="disk-box-group" aria-label={group}>
              <h2 className="disk-box-group-label">
                <span>{group}</span>
                <span>{groups[group].length}</span>
              </h2>
              {groups[group].map(({ summary, lamp }) => {
                const current = summary.id === currentId;
                return (
                  <button
                    key={summary.id}
                    type="button"
                    className="disk-box-row"
                    aria-current={current ? "page" : undefined}
                    onClick={() => navigate(`/sessions/${summary.id}`)}
                    title={floppyTitle(summary)}
                  >
                    <span className={`lamp lamp-${lamp}`} role="img" aria-label={LAMP_WORD[lamp]} />
                    <span className="disk-box-row-title">{floppyTitle(summary)}</span>
                    {lamp === "needsYou" ? (
                      <span className="disk-box-row-flag">NEEDS YOU</span>
                    ) : (
                      <span className="disk-box-row-time">{shortWhen(summary.updatedAt)}</span>
                    )}
                    <span className="disk-box-row-meta">{rowMeta(summary)}</span>
                  </button>
                );
              })}
            </section>
          ),
        )}
        {archived ? (
          <p className="disk-box-group-label disk-box-archive" title={vocabulary.archive.hint}>
            <span>{vocabulary.archive.one}</span>
            <span>{archived}</span>
          </p>
        ) : null}
      </div>
      <div className="disk-box-foot">
        <NavLink to="/" end className="icon-btn" title={vocabulary.desk.hint} aria-label={vocabulary.desk.one}>
          ⌂
        </NavLink>
        <span className="disk-box-foot-spacer" />
        <ProviderStrip />
        <SoundToggle compact />
        <ThemeToggle compact />
        <PopMenu label="Pages" icon="☰" placement="above">
          {(close) => (
            <>
              {navItems.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} role="menuitem" title={item.hint} onClick={close}>
                  {item.label}
                </NavLink>
              ))}
              <button
                type="button"
                role="menuitem"
                title="KERNAL GAMES"
                aria-label="SYS 64738: open KERNAL GAMES"
                onClick={() => {
                  close();
                  void openEasterEgg();
                }}
              >
                SYS 64738
              </button>
            </>
          )}
        </PopMenu>
      </div>
      {newOpen && (
        <NewSessionDialog
          gurus={gurus}
          onClose={() => setNewOpen(false)}
          onCreated={(id) => {
            setNewOpen(false);
            navigate(`/sessions/${id}`);
          }}
        />
      )}
    </nav>
  );
}
