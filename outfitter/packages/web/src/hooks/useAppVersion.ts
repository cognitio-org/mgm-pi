import { useEffect, useRef, useState } from "react";
import { api, type AppVersion } from "../api/client.ts";

/** How often an open tab re-checks what's deployed (also on return to the tab). */
export const VERSION_CHECK_MS = 10 * 60_000;

/** "2026.09.27.9" for a release, else the short commit, else null (dev). */
export function versionLabel(v: AppVersion | null): string | null {
  if (!v) return null;
  if (v.release) return v.release.replace(/^outfitter-v/, "");
  return v.commit ? v.commit.slice(0, 12) : null;
}

/**
 * What Outfitter is running (GET /api/version), and whether it changed since this page loaded: a
 * tab left open across a release runs the old bundle against the new api until it reloads. The
 * first answer is the page's own version; a later one with a different commit means an update.
 */
export function useAppVersion(): { version: AppVersion | null; updated: AppVersion | null } {
  const [version, setVersion] = useState<AppVersion | null>(null);
  const [updated, setUpdated] = useState<AppVersion | null>(null);
  const loaded = useRef<AppVersion | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const v = await api.version();
        if (cancelled) return;
        if (!loaded.current) {
          loaded.current = v;
          setVersion(v);
        } else if (v.commit && loaded.current.commit && v.commit !== loaded.current.commit) {
          setUpdated(v);
        }
      } catch {
        // Informational only: a failed check changes nothing.
      }
    };
    void check();
    const timer = setInterval(() => void check(), VERSION_CHECK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return { version, updated };
}
