import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api/client.ts";
import { localHostsApi, type LocalHostView } from "../api/local-hosts.ts";

/** Heartbeats are every 5 minutes, and a load or unload sends one at once. 30s keeps the
 * Desk LEDs and the Modems page current without a per-request stream (there is no busy state). */
export const LOCAL_HOSTS_REFRESH_MS = 30_000;

export function useLocalHosts(): { hosts: LocalHostView[]; loaded: boolean; error: string | null; reload: () => void } {
  const [hosts, setHosts] = useState<LocalHostView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      localHostsApi
        .list()
        .then((res) => {
          if (cancelled) return;
          setHosts(res.hosts);
          setError(null);
          setLoaded(true);
        })
        .catch((err) => {
          if (cancelled) return;
          // Keep the last list: a failed poll should not blank the page.
          setError(err instanceof ApiError ? err.message : "Couldn't load local hosts");
          setLoaded(true);
        });
    };
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, LOCAL_HOSTS_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tick]);

  return { hosts, loaded, error, reload };
}
