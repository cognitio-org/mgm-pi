/**
 * Validates a `run.spec.workspace.snapshotUrl` / `run.spec.snapshot.url` before agentd fetches it
 * (workspace.ts's `restoreWorkspace`, run.ts's `begin()`). Finding #3 in
 * docs/reports/security-review-pr1.md: without this, either field could carry an internal URL (the
 * GCE metadata server, `http://169.254.169.254/...`, reachable from inside the Cloud Run Job's
 * network namespace) and agentd would fetch it blind (SSRF).
 *
 * Pure and side-effect-free so it's unit-testable without touching the network; see
 * packages/api/src/snapshot-url.ts for the equivalent validator the API runs before persisting a
 * `checkpoint` frame's URLs (duplicated rather than shared across packages -- agentd and api ship
 * and deploy independently, see git.ts's module doc for the same tradeoff elsewhere in this repo).
 */

export interface SnapshotUrlValidationOptions {
  /** SNAPSHOT_HOST_ALLOWLIST: hosts an https snapshot/workspace URL may point at. */
  allowlist: string[];
  /** OUTFITTER_DEV=1: also allow file:// URLs and plain local paths (local smoke tests only). */
  devMode: boolean;
}

/** Throws with a clear reason when `url` is not an acceptable snapshot/workspace URL; returns
 * (void) silently when it is. */
export function validateSnapshotUrl(url: string, opts: SnapshotUrlValidationOptions): void {
  const isHttp = url.startsWith("http://") || url.startsWith("https://");
  if (!isHttp) {
    // file:// URL or a plain local path -- only ever acceptable in dev mode (workspace.ts's
    // restoreWorkspace already supports both forms for local smoke tests).
    if (!opts.devMode) {
      throw new Error(`snapshot/workspace URL must be https:// unless OUTFITTER_DEV=1: ${url}`);
    }
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid snapshot/workspace URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`snapshot/workspace URL must use https:, got ${parsed.protocol} (${url})`);
  }
  if (!opts.allowlist.includes(parsed.hostname)) {
    throw new Error(
      `snapshot/workspace URL host "${parsed.hostname}" is not in SNAPSHOT_HOST_ALLOWLIST (${opts.allowlist.join(", ")})`,
    );
  }
}

/** SNAPSHOT_HOST_ALLOWLIST env parsing, shared by main.ts (workspace.ts's caller) and run.ts. */
export function snapshotHostAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.SNAPSHOT_HOST_ALLOWLIST;
  if (!raw) return ["storage.googleapis.com"];
  const hosts = raw.split(",").map((h) => h.trim()).filter(Boolean);
  return hosts.length > 0 ? hosts : ["storage.googleapis.com"];
}

/** OUTFITTER_DEV=1, matching config.ts's `devMode` parsing convention on the api side. */
export function isDevMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OUTFITTER_DEV === "1";
}
