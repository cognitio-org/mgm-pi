import { useCallback, useEffect, useId, useRef, useState } from "react";
import { api, ApiError, type IdeState } from "../api/client.ts";
import { toApiErrorState } from "../lib/api-error.ts";
import { Working } from "./Working.tsx";
import type { ApiErrorState } from "./SystemErrorDialog.tsx";

/** How often the chip re-reads the IDE's state: quickly while it's starting, slowly otherwise. */
export const IDE_REFRESH_MS = 15_000;
export const IDE_STARTING_REFRESH_MS = 2_000;
/** A start that hasn't moved on for this long probably lost a frame (ide.status isn't replayed):
 * the button comes back so another click can ask again. */
export const IDE_STALE_START_MS = 90_000;

const LIVE = new Set(["queued", "provisioning", "running", "idle", "stopping"]);
/** The api opens an IDE only on a Drive that's up for good. */
const OPENABLE = new Set(["running", "idle"]);
const STARTING = new Set(["requested", "installing", "starting"]);

interface Props {
  sessionId: string;
  runState: string | null | undefined;
  onError: (error: ApiErrorState) => void;
  /** Tests: the clock the stale-start check reads. */
  now?: () => number;
}

function startingLabel(state: string): string {
  if (state === "installing") return "Installing VS Code";
  if (state === "starting") return "Starting VS Code";
  return "Opening VS Code";
}

/**
 * #243: the browser IDE (docs/specs/browser-ide.md), next to the preview chips. Only the floppy's
 * owner or a sysop sees it (the api answers 403 to anyone else; the chip then stays hidden and stops
 * asking), and only on a Drive whose Tape has "VS Code in the browser". "Open in VS Code" asks the
 * Drive to start it; the same button stays in place, busy, while it installs and starts (the chip
 * polls every 2 s), then becomes a link to the IDE (behind Google sign-in, for the owner and sysops
 * only) with "Close", which ends the public address while code-server keeps running. There is no
 * share control: the IDE is a shell.
 *
 * The link isn't opened automatically: the IDE is ready 20-30 s after the click, and a browser
 * blocks a new tab that doesn't come straight from one. A screen reader hears when it's ready.
 */
export function IdeChip({ sessionId, runState, onError, now = Date.now }: Props) {
  const [ide, setIde] = useState<IdeState | null>(null);
  const [busy, setBusy] = useState<"open" | "close" | null>(null);
  const [announce, setAnnounce] = useState("");
  const live = Boolean(runState && LIVE.has(runState));
  const openable = Boolean(runState && OPENABLE.has(runState));
  const current = useRef(sessionId);
  const forbidden = useRef(false);
  const openRef = useRef<HTMLButtonElement | null>(null);
  const linkRef = useRef<HTMLAnchorElement | null>(null);
  const focusAfter = useRef<"open" | null>(null);
  const noteId = useId();

  const load = useCallback(async () => {
    const asked = sessionId;
    if (forbidden.current) return;
    try {
      const next = await api.ide(asked);
      if (current.current === asked) setIde(next);
    } catch (err) {
      // Not the owner or a sysop: stay hidden, and stop asking until the session changes.
      if (err instanceof ApiError && err.status === 403) forbidden.current = true;
      /* otherwise keep the last state and try again later */
    }
  }, [sessionId]);

  useEffect(() => {
    current.current = sessionId;
    forbidden.current = false;
    setIde(null);
    setAnnounce("");
  }, [sessionId]);

  const stale = Boolean(ide && STARTING.has(ide.state) && ide.updatedAt && now() - Date.parse(ide.updatedAt) > IDE_STALE_START_MS);
  const starting = Boolean(ide && STARTING.has(ide.state) && !stale);
  useEffect(() => {
    if (!live) {
      setIde(null);
      return;
    }
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, starting ? IDE_STARTING_REFRESH_MS : IDE_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [live, load, starting]);

  // Tell a screen reader when it's ready, since the busy region it heard goes away.
  const ready = ide?.state === "ready" && Boolean(ide.url?.startsWith("https://"));
  useEffect(() => {
    if (ready) setAnnounce("VS Code is ready. Open it from the VS Code link.");
  }, [ready]);

  // After Close, keep focus on the chip: the button that had it is gone.
  useEffect(() => {
    if (focusAfter.current === "open" && !ready) {
      focusAfter.current = null;
      openRef.current?.focus();
    }
  });

  if (!ide?.available) return null;

  async function open() {
    if (busy !== null || starting) return; // aria-disabled while it works, so it keeps focus
    const asked = sessionId;
    setBusy("open");
    setAnnounce("");
    try {
      const next = await api.openIde(asked);
      if (current.current === asked) setIde(next);
    } catch (err) {
      if (current.current === asked) onError(toApiErrorState(err, "Couldn't open VS Code"));
    } finally {
      setBusy(null);
    }
  }

  async function close() {
    const asked = sessionId;
    setBusy("close");
    try {
      await api.closeIde(asked);
      if (current.current === asked) {
        // Don't leave the old link up if the re-read below fails.
        setIde((s) => (s ? { ...s, state: "closed", url: undefined } : s));
        focusAfter.current = "open";
        setAnnounce("");
        await load();
      }
    } catch (err) {
      onError(toApiErrorState(err, "Couldn't close VS Code"));
    } finally {
      setBusy(null);
    }
  }

  const liveRegion = (
    <span className="sr-only" aria-live="polite">
      {announce}
    </span>
  );

  if (ready) {
    return (
      <span className="preview-cluster ide-cluster">
        <a
          ref={linkRef}
          className="preview-chip ide-chip"
          href={ide.url}
          target="_blank"
          rel="noopener noreferrer"
          title="Open this Drive's files in VS Code. Only the floppy's owner and sysops can open it; they sign in with Google."
        >
          <span aria-hidden="true">↗</span> VS Code<span className="sr-only"> (opens in a new tab)</span>
        </a>
        <button type="button" className="chip-btn" onClick={close} disabled={busy !== null} aria-label="Close VS Code's address">
          {busy === "close" ? <Working label="Closing" /> : "Close"}
        </button>
        {liveRegion}
      </span>
    );
  }

  // One button through open → installing → starting, so focus stays on it; busy while it works.
  const working = busy === "open" || starting;
  const failed = ide.state === "error" || ide.state === "stopped";
  const note = stale
    ? "VS Code is taking a while. Try again?"
    : failed
      ? `${ide.state === "stopped" ? "VS Code stopped" : "VS Code didn't start"}${ide.detail ? `: ${ide.detail}` : ""}`
      : undefined;
  return (
    <span className="preview-cluster ide-cluster">
      <button
        ref={openRef}
        type="button"
        className="chip-btn ide-open-btn"
        onClick={open}
        // Real `disabled` only when the Drive can't take it; while working it stays focusable.
        disabled={!openable}
        aria-disabled={working || undefined}
        aria-busy={working || undefined}
        aria-describedby={note ? noteId : undefined}
        title={openable ? "Open this Drive's files in VS Code in the browser, with a terminal. Only the floppy's owner and sysops can open it." : "The Drive has to be running first."}
      >
        {working ? <Working label={startingLabel(busy === "open" && !starting ? "requested" : ide.state)} srOnly={false} /> : stale ? "Try again" : "Open in VS Code"}
      </button>
      {note && (
        <span className="ide-note" id={noteId} title={note}>
          {note}
        </span>
      )}
      {liveRegion}
    </span>
  );
}
