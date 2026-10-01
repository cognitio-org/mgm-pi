/** Cloud pushes may update the session branch and any branch under this prefix. */
export const DEFAULT_BRANCH_PREFIX = "outfitter/";

/**
 * A stored guru value. Empty means "use the default". A present invalid value is `ok: false`
 * so a save can reject it instead of silently widening what a run may push.
 */
export function parseBranchPrefix(raw: unknown): { ok: true; prefix?: string } | { ok: false } {
  if (raw === undefined || raw === null || raw === "") return { ok: true };
  if (typeof raw !== "string") return { ok: false };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true };
  if (
    /[\s\0~^:?*\[\\\]]/.test(trimmed) ||
    trimmed.includes("..") ||
    trimmed.startsWith("-") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("refs/")
  ) {
    return { ok: false };
  }
  return { ok: true, prefix: trimmed.endsWith("/") ? trimmed : `${trimmed}/` };
}

/** What a run actually enforces. A missing guru value is `outfitter/`. */
export function branchPrefixOf(raw: unknown): string {
  const parsed = parseBranchPrefix(raw);
  if (!parsed.ok) return DEFAULT_BRANCH_PREFIX;
  return parsed.prefix ?? DEFAULT_BRANCH_PREFIX;
}

function safeBranch(branch: string): boolean {
  return (
    branch.length > 0 &&
    branch.length <= 200 &&
    !branch.startsWith("-") &&
    !branch.startsWith("refs/") &&
    !branch.includes("..") &&
    !/[\s\0~^:?*\[\\\]]/.test(branch)
  );
}

/** The session branch is always allowed. Other branches must sit under the prefix. */
export function branchAllowed(branch: string, sessionBranch: string, prefix: string): boolean {
  if (!safeBranch(branch)) return false;
  if (sessionBranch && branch === sessionBranch) return true;
  if (!prefix) return false;
  return branch.startsWith(prefix);
}

/**
 * E9 §5.3/§8: the prefix a session's runs may push under. An A2A task's session may push only its
 * own `outfitter/a2a-<task8>` branch, whatever its tape's prefix: `branchAllowed` always allows the
 * session branch, and the prefix becomes that branch plus `/`, which git can't hold alongside the
 * branch itself and which no other session's branch starts with. Every other session keeps its
 * tape's prefix (branchPrefixOf).
 */
export function branchPrefixForSession(
  session: { origin?: string; branch?: string } | null | undefined,
  guruPrefix: unknown,
): string {
  if (session?.origin === "a2a" && session.branch) return `${session.branch}/`;
  return branchPrefixOf(guruPrefix);
}
