import { useEffect, useState } from "react";
import { api, type ProviderRow } from "../api/client.ts";

/** GET /api/providers is built by another workstream (see EPIC.md E3.6 / E2.10); the client
 * tolerates a 404 by resolving to []. `loaded` distinguishes "still fetching" from "fetched, and
 * there are none" so callers (ProviderStrip) can render nothing during the initial fetch too. */
export function useProviders(): { providers: ProviderRow[]; loaded: boolean } {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .providers()
      .then((rows) => {
        if (!cancelled) {
          setProviders(rows);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { providers, loaded };
}
