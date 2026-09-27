import { useEffect, useState } from "react";
import { api, type ProviderRow } from "../api/client.ts";

/** How often a visible page re-reads GET /api/providers. The api re-probes only when its own view
 * is older than PROVIDER_POLL_MS, so most of these are a cached read; without them the header strip
 * (always mounted) kept showing whatever was true at page load -- "cold" all morning after the warm
 * pool had scaled up (#190). */
export const PROVIDERS_REFRESH_MS = 60_000;

/** GET /api/providers is built by another workstream (see EPIC.md E3.6 / E2.10); the client
 * tolerates a 404 by resolving to []. `loaded` distinguishes "still fetching" from "fetched, and
 * there are none" so callers (ProviderStrip) can render nothing during the initial fetch too.
 * Re-reads every PROVIDERS_REFRESH_MS while the tab is visible, and as soon as it becomes visible. */
export function useProviders(): { providers: ProviderRow[]; loaded: boolean } {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api
        .providers()
        .then((rows) => {
          if (!cancelled) {
            setProviders(rows);
            setLoaded(true);
          }
        })
        .catch(() => {
          // A failed refresh keeps the last rows rather than blanking the strip.
          if (!cancelled) setLoaded(true);
        });
    };
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, PROVIDERS_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return { providers, loaded };
}
