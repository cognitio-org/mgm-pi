// The repository field on New Floppy. The list comes from the GitHub App the first time the
// field is opened (a click, typing, or ArrowDown) — focus alone does not ask, so opening the
// dialog does not hit the network. A name the App cannot see can still be typed. Create is a
// second step, with private on by default, and only for an account the App is installed on.

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api, type GithubCatalogSnapshot, type GithubRepoSummary } from "../api/client.ts";
import { normalizeRepoInput, repoMenu, type RepoMenuItem } from "../lib/repo-choice.ts";
import { GithubGlyph, type GithubGlyphName } from "./GithubGlyphs.tsx";
import { SyntaxError } from "./SyntaxError.tsx";

function defaultLoadRepos(fresh?: boolean): Promise<GithubCatalogSnapshot> {
  return api.githubRepos(fresh);
}

function defaultCreateRepo(input: { owner: string; name: string; private?: boolean }): Promise<{ repo: GithubRepoSummary }> {
  return api.createGithubRepo(input);
}

function menuGlyph(kind: RepoMenuItem["kind"]): GithubGlyphName {
  if (kind === "none") return "none";
  if (kind === "create") return "plus";
  if (kind === "use") return "pencil";
  return "repo";
}

/** Icon, then the label, with no whitespace text nodes between them. The button's text stays
 * the label ("ada/notes", "Create acme/new") so a private lock does not rename the choice. */
function menuContents(item: RepoMenuItem, repos: GithubRepoSummary[]): ReactNode[] {
  const priv = item.kind === "repo" && repos.some((repo) => repo.fullName === item.value && repo.private);
  return [
    <GithubGlyph key="mark" name={menuGlyph(item.kind)} />,
    priv ? (
      <span key="lock" className="repo-menu-lock" role="img" aria-label="private" title="Private">
        <GithubGlyph name="lock" />
      </span>
    ) : null,
    item.label,
  ];
}

function catalogNote(reason: GithubCatalogSnapshot["reason"]): string {
  if (reason === "misconfigured") return "The GitHub App secrets aren't usable. Type owner/repo.";
  if (reason === "unavailable") return "GitHub is unavailable right now. Type owner/repo.";
  return "The GitHub App isn't set up. Type owner/repo.";
}

interface Props {
  id: string;
  value: string;
  onChange: (next: string) => void;
  loadRepos?: (fresh?: boolean) => Promise<GithubCatalogSnapshot>;
  createRepo?: (input: { owner: string; name: string; private?: boolean }) => Promise<{ repo: GithubRepoSummary }>;
}

export function RepoField({ id, value, onChange, loadRepos = defaultLoadRepos, createRepo = defaultCreateRepo }: Props) {
  const [open, setOpen] = useState(false);
  const [snap, setSnap] = useState<GithubCatalogSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [pending, setPending] = useState<{ owner: string; name: string } | null>(null);
  const [privateRepo, setPrivateRepo] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  const items = repoMenu(value, snap?.repos ?? [], snap?.accounts ?? []);
  const activeIndex = items.length === 0 ? 0 : Math.min(active, items.length - 1);

  async function ensure(fresh = false) {
    if (loadedRef.current && !fresh) return;
    loadedRef.current = true;
    setLoading(true);
    try {
      const next = await loadRepos(fresh);
      setSnap(next);
      setLoadError(null);
    } catch (err) {
      loadedRef.current = false;
      setLoadError(err instanceof Error ? err.message : "Could not load repositories");
    } finally {
      setLoading(false);
    }
  }

  function choose(item: RepoMenuItem) {
    if (item.kind === "create") {
      const [owner, name] = item.value.split("/");
      if (!owner || !name) return;
      setPending({ owner, name });
      setPrivateRepo(true);
      setCreateError(null);
      return;
    }
    onChange(item.value);
    setPending(null);
    setOpen(false);
  }

  async function confirmCreate() {
    if (!pending || creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const { repo } = await createRepo({ owner: pending.owner, name: pending.name, private: privateRepo });
      onChange(repo.fullName);
      setPending(null);
      setOpen(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Could not create the repository");
    } finally {
      setCreating(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      void ensure();
      if (!open) {
        setOpen(true);
        setActive(0);
        return;
      }
      setActive((current) => {
        const index = items.length === 0 ? 0 : Math.min(current, items.length - 1);
        if (e.key === "ArrowDown") return Math.min(items.length - 1, index + 1);
        return Math.max(0, index - 1);
      });
      return;
    }
    if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key === "Enter" && open) {
      e.preventDefault();
      if (pending) {
        void confirmCreate();
        return;
      }
      const item = items[activeIndex];
      if (item) choose(item);
    }
  }

  return (
    <div className="repo-field">
      <input
        id={id}
        value={value}
        placeholder="owner/repo"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={open ? `${id}-menu` : undefined}
        onClick={() => {
          setOpen(true);
          void ensure();
        }}
        onChange={(e) => {
          onChange(e.target.value);
          setPending(null);
          setActive(0);
          setOpen(true);
          void ensure();
        }}
        onBlur={() => {
          const next = normalizeRepoInput(value);
          if (next !== value) onChange(next);
          // Menu clicks prevent this blur, so closing here only happens when focus actually leaves.
          setOpen(false);
        }}
        onKeyDown={onKeyDown}
      />
      <p className="session-meta">
        {snap && !snap.configured
          ? catalogNote(snap.reason)
          : "Leave this empty for no repository. Pick one the App can reach, create one on a connected account, or type owner/repo."}
      </p>
      {loadError && <SyntaxError>{loadError}</SyntaxError>}
      {open && (
        <div id={`${id}-menu`} className="repo-menu" role="listbox" onMouseDown={(e) => e.preventDefault()}>
          {loading && items.length === 0 && <p className="session-meta">Loading repositories…</p>}
          {items.map((item, index) => (
            <button
              key={`${item.kind}:${item.value}:${item.label}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={index === activeIndex ? "is-active" : undefined}
              onClick={() => choose(item)}
            >
              {menuContents(item, snap?.repos ?? [])}
            </button>
          ))}
          {snap?.truncated && <p className="session-meta">Some repositories may be missing.</p>}
        </div>
      )}
      {pending && (
        <div className="repo-create">
          <label className="repo-create-private">
            <input
              type="checkbox"
              checked={privateRepo}
              onChange={(e) => setPrivateRepo(e.target.checked)}
            />
            <GithubGlyph name="lock" />
            Private
          </label>
          <button type="button" className="btn" onClick={() => void confirmCreate()} disabled={creating}>
            {creating ? "Creating…" : "Create repository"}
          </button>
        </div>
      )}
      {createError && <SyntaxError>{createError}</SyntaxError>}
      {snap?.reason === "unavailable" && (
        <button type="button" className="btn" onClick={() => void ensure(true)}>
          Try again
        </button>
      )}
    </div>
  );
}
