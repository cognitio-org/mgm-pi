/**
 * Validates a `checkpoint` frame's `snapshotUrl`/`workspaceUrl` before agentlink.ts persists it onto
 * `Session.checkpoint` -- those fields round-trip back out as `run.spec.workspace.snapshotUrl` /
 * `run.spec.snapshot.url` on the *next* run and get fetched there (agentd's workspace.ts /
 * run.ts). Finding #3 in docs/reports/security-review-pr1.md: without server-side validation too,
 * a forged or buggy `checkpoint` frame could plant an internal URL (GCE metadata server) or a
 * non-https host and agentd would fetch it blind on resume (SSRF).
 *
 * Pure and side-effect-free (no config.ts dependency -- reads env directly so this file has no
 * import-time coupling to the rest of api's config wiring) so it's unit-testable in isolation.
 * Mirrors packages/agentd/src/snapshot-url.ts's validator; duplicated rather than shared because
 * agentd and api ship and deploy independently (see agentd/src/git.ts's module doc for the same
 * tradeoff elsewhere in this repo).
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

/** SNAPSHOT_HOST_ALLOWLIST env parsing, matching agentd's snapshot-url.ts. */
export function snapshotHostAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.SNAPSHOT_HOST_ALLOWLIST;
  if (!raw) return ["storage.googleapis.com"];
  const hosts = raw.split(",").map((h) => h.trim()).filter(Boolean);
  return hosts.length > 0 ? hosts : ["storage.googleapis.com"];
}

/** OUTFITTER_DEV=1, matching config.ts's `devMode` parsing convention. */
export function isDevMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OUTFITTER_DEV === "1";
}
