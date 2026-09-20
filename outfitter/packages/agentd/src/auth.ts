/**
 * Google ID token for the agentd -> api WebSocket handshake (Authorization: Bearer <token>,
 * audience = api origin). On GCE/Cloud Run the job's service-account identity comes from the
 * metadata server; locally OUTFITTER_DEV_TOKEN stands in (protocol.md: "local dev:
 * OUTFITTER_DEV_TOKEN").
 */

const METADATA_BASE = "http://metadata.google.internal/computeMetadata/v1";
const METADATA_TIMEOUT_MS = 2000;

export interface GetTokenOptions {
  /** Overrides the metadata server base URL, for tests. */
  metadataBase?: string;
  /** Overrides the request timeout, for tests. */
  timeoutMs?: number;
  /** Injectable fetch, defaults to the global. */
  fetchFn?: typeof fetch;
}

/** Fetches a Google-signed identity token scoped to `audience` from the GCE/Cloud Run metadata
 * server. Falls back to `devToken` (OUTFITTER_DEV_TOKEN) when the metadata server is unreachable
 * (i.e. not running on GCP) and `devToken` is set. Throws if neither source yields a token. */
export async function getIdToken(
  audience: string,
  devToken: string | undefined,
  opts: GetTokenOptions = {},
): Promise<string> {
  const base = opts.metadataBase ?? METADATA_BASE;
  const timeoutMs = opts.timeoutMs ?? METADATA_TIMEOUT_MS;
  const doFetch = opts.fetchFn ?? fetch;

  const url = `${base}/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}&format=full`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      headers: { "Metadata-Flavor": "Google" },
      signal: controller.signal,
    });
    if (res.ok) {
      const token = (await res.text()).trim();
      if (token) return token;
    }
  } catch {
    // metadata server unreachable (not on GCP, or sandboxed locally) -- fall through to dev token
  } finally {
    clearTimeout(timer);
  }

  if (devToken) return devToken;
  throw new Error(
    "getIdToken: no GCE metadata server reachable and OUTFITTER_DEV_TOKEN is not set",
  );
}
