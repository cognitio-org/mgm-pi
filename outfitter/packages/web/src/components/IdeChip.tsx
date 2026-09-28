import { useCallback, useEffect, useRef, useState } from "react";
import { api, type IdeState } from "../api/client.ts";
import { toApiErrorState } from "../lib/api-error.ts";
import { Working } from "./Working.tsx";
import type { ApiErrorState } from "./SystemErrorDialog.tsx";

/** How often the chip re-reads the IDE's state: quickly while it's starting, slowly otherwise. */
export const IDE_REFRESH_MS = 15_000;
export const IDE_STARTING_REFRESH_MS = 2_000;

const LIVE = new Set(["queued", "provisioning", "running", "idle", "stopping"]);
const STARTING = new Set(["requested", "installing", "starting"]);

interface Props {
  sessionId: string;
  runState: string | null | undefined;
  onError: (error: ApiErrorState) => void;
}

function startingLabel(state: string): string {
  if (state === "installing") return "Installing VS Code";
  if (state === "starting") return "Starting VS Code";
  return "Opening VS Code";
}

/**
 * #243: the browser IDE (docs/specs/browser-ide.md), next to the preview chips. Only the floppy's
 * owner or a sysop sees it (the api answers 403 to anyone else, and the chip stays hidden), and only
 * on a Drive whose Tape has "VS Code in the browser". "Open in VS Code" asks the Drive to start it;
 * while it installs and starts the chip polls every 2 s, then becomes a link to the IDE (behind
 * Google sign-in, for the owner and sysops only) with "Close", which ends the public address while
 * code-server keeps running. There is no share control: the IDE is a shell.
 *
 * The link isn't opened automatically: the IDE is ready 20-30 s after the click, and a browser
 * blocks a new tab that doesn't come straight from one.
 */
export function IdeChip({ sessionId, runState, onError }: Props) {
  const [ide, setIde] = useState<IdeState | null>(null);
  const [busy, setBusy] = useState<"open" | "close" | null>(null);
  const live = Boolean(runState && LIVE.has(runState));
  const current = useRef(sessionId);

  const load = useCallback(async () => {
    const asked = sessionId;
    try {
      const next = await api.ide(asked);
      if (current.current === asked) setIde(next);
    } catch {
      // Not the owner or a sysop (403), or a hiccup: stay hidden or keep the last state.
      /* keep the last state (or stay hidden) */
    }
  }, [sessionId]);

  useEffect(() => {
    current.current = sessionId;
    setIde(null);
  }, [sessionId]);

  const starting = Boolean(ide && STARTING.has(ide.state));
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

  if (!ide?.available) return null;

  async function open() {
    setBusy("open");
    try {
      setIde(await api.openIde(sessionId));
    } catch (err) {
      onError(toApiErrorState(err, "Couldn't open VS Code"));
    } finally {
      setBusy(null);
    }
  }

  async function close() {
    setBusy("close");
    try {
      await api.closeIde(sessionId);
      await load();
    } catch (err) {
      onError(toApiErrorState(err, "Couldn't close VS Code"));
    } finally {
      setBusy(null);
    }
  }

  if (ide.state === "ready" && ide.url?.startsWith("https://")) {
    return (
      <span className="preview-cluster ide-cluster">
        <a
          className="preview-chip ide-chip"
          href={ide.url}
          target="_blank"
          rel="noopener noreferrer"
          title="Open this Drive's files in VS Code. Only the floppy's owner and sysops can open it; they sign in with Google."
        >
          <span aria-hidden="true">↗</span> VS Code
        </a>
        <button type="button" className="chip-btn" onClick={close} disabled={busy !== null} aria-label="Close VS Code's address">
          {busy === "close" ? <Working label="Closing" /> : "Close"}
        </button>
      </span>
    );
  }

  if (starting) {
    return (
      <span className="preview-chip ide-chip ide-chip-starting" title="The Drive is getting VS Code ready. The first time takes about half a minute.">
        <Working label={startingLabel(ide.state)} srOnly={false} />
      </span>
    );
  }

  const note = ide.state === "error" || ide.state === "stopped" ? ide.detail : undefined;
  return (
    <span className="preview-cluster ide-cluster">
      <button
        type="button"
        className="chip-btn ide-open-btn"
        onClick={open}
        disabled={busy !== null}
        title="Open this Drive's files in VS Code in the browser, with a terminal. Only the floppy's owner and sysops can open it."
      >
        {busy === "open" ? <Working label="Opening VS Code" /> : "Open in VS Code"}
      </button>
      {note && (
        <span className="ide-note" title={note}>
          {ide.state === "stopped" ? "VS Code stopped" : "VS Code didn't start"}
        </span>
      )}
    </span>
  );
}
