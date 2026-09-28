import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type IdeState } from "../api/client.ts";
import { toApiErrorState } from "../lib/api-error.ts";
import type { ApiErrorState } from "./SystemErrorDialog.tsx";

/** How often the IDE's state is re-read: quickly while it's starting, slowly otherwise. */
export const IDE_REFRESH_MS = 15_000;
export const IDE_STARTING_REFRESH_MS = 2_000;
/** A start that hasn't moved on for this long probably lost a frame (ide.status isn't replayed):
 * the button comes back so another click can ask again. */
export const IDE_STALE_START_MS = 90_000;

const LIVE = new Set(["queued", "provisioning", "running", "idle", "stopping"]);
/** The api opens an IDE only on a Drive that's up for good. */
const OPENABLE = new Set(["running", "idle"]);
const STARTING = new Set(["requested", "installing", "starting"]);

export interface IdeController {
  ide: IdeState | null;
  /** The api said 403: not the floppy's owner or a sysop. Nothing is polled after that. */
  forbidden: boolean;
  /** Installing or starting, and not stale. */
  starting: boolean;
  /** Pending for over IDE_STALE_START_MS: offer "Try again". */
  stale: boolean;
  /** The Drive is running or idle, so an open can be asked for. */
  openable: boolean;
  ready: boolean;
  busy: "open" | "close" | null;
  open: () => Promise<void>;
  close: () => Promise<boolean>;
}

const IdeContext = createContext<IdeController | null>(null);

/** The session page's one view of its Drive's IDE, shared by the status-bar chip and any chat chips
 * (the `vscode` tool, #273), so there's one poller however many show it. */
export function useIde(): IdeController | null {
  return useContext(IdeContext);
}

interface ProviderProps {
  sessionId: string;
  runState: string | null | undefined;
  onError: (error: ApiErrorState) => void;
  /** Tests: the clock the stale-start check reads. */
  now?: () => number;
  children: ReactNode;
}

export function IdeProvider({ sessionId, runState, onError, now = Date.now, children }: ProviderProps) {
  const [ide, setIde] = useState<IdeState | null>(null);
  const [busy, setBusy] = useState<"open" | "close" | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const live = Boolean(runState && LIVE.has(runState));
  const openable = Boolean(runState && OPENABLE.has(runState));
  const current = useRef(sessionId);
  const forbiddenRef = useRef(false);

  const load = useCallback(async () => {
    const asked = sessionId;
    if (forbiddenRef.current) return;
    try {
      const next = await api.ide(asked);
      if (current.current === asked) setIde(next);
    } catch (err) {
      // Not the owner or a sysop: stay hidden, and stop asking until the session changes.
      if (err instanceof ApiError && err.status === 403 && current.current === asked) {
        forbiddenRef.current = true;
        setForbidden(true);
      }
      /* otherwise keep the last state and try again later */
    }
  }, [sessionId]);

  useEffect(() => {
    current.current = sessionId;
    forbiddenRef.current = false;
    setForbidden(false);
    setIde(null);
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

  const ready = ide?.state === "ready" && Boolean(ide.url?.startsWith("https://"));

  const open = useCallback(async () => {
    if (busy !== null || starting) return;
    const asked = sessionId;
    setBusy("open");
    try {
      const next = await api.openIde(asked);
      if (current.current === asked) setIde(next);
    } catch (err) {
      if (current.current === asked) onError(toApiErrorState(err, "Couldn't open VS Code"));
    } finally {
      setBusy(null);
    }
  }, [busy, starting, sessionId, onError]);

  /** Resolves true once closed (callers move focus). */
  const close = useCallback(async () => {
    const asked = sessionId;
    setBusy("close");
    try {
      await api.closeIde(asked);
      if (current.current !== asked) return false;
      // Don't leave the old link up if the re-read below fails.
      setIde((s) => (s ? { ...s, state: "closed", url: undefined } : s));
      await load();
      return true;
    } catch (err) {
      onError(toApiErrorState(err, "Couldn't close VS Code"));
      return false;
    } finally {
      setBusy(null);
    }
  }, [sessionId, load, onError]);

  const value = useMemo<IdeController>(
    () => ({ ide, forbidden, starting, stale, openable, ready, busy, open, close }),
    [ide, forbidden, starting, stale, openable, ready, busy, open, close],
  );
  return <IdeContext.Provider value={value}>{children}</IdeContext.Provider>;
}

export function startingLabel(state: string): string {
  if (state === "installing") return "Installing VS Code";
  if (state === "starting") return "Starting VS Code";
  return "Opening VS Code";
}
