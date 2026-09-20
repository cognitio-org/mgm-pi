/** Pure logic for the mgm update check; tested without pi. */
export const REPO = "mgmonteleone/mgm-pi";
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type Semver = [number, number, number];

/** "v0.1.4", "0.1.4", "0.1.4\npi 0.86.1" → [0,1,4]; undefined when it is not a release version. */
export function parseVersion(text: string | undefined): Semver | undefined {
  const m = (text ?? "").trim().split(/\s+/)[0]?.match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}
export const showVersion = (v: Semver) => v.join(".");

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

export type CheckCache = { checkedAt: number; latest?: string };

/** A check is due when there is no cache, the cache is stale, or the caller forces it. */
export function checkDue(cache: CheckCache | undefined, now: number, force = false, interval = CHECK_INTERVAL_MS): boolean {
  if (force) return true;
  if (!cache || typeof cache.checkedAt !== "number") return true;
  return now - cache.checkedAt >= interval;
}

/** What to tell the user, or undefined when nothing newer is known. */
export function updateNotice(installed: string | undefined, latest: string | undefined): string | undefined {
  const i = parseVersion(installed); const l = parseVersion(latest);
  if (!i || !l || compareVersions(l, i) <= 0) return undefined;
  return `mgm ${showVersion(l)} is available (you have ${showVersion(i)}). Run /update to install it, then restart mgm.`;
}

/** The tag from `gh release view --json tagName` output. */
export function tagFromGh(json: string): string | undefined {
  try { const t = JSON.parse(json)?.tagName; return typeof t === "string" ? t : undefined; } catch { return undefined; }
}
