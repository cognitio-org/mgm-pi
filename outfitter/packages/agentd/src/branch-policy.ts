/** Cloud pushes may update the session branch and any branch under this prefix. */
export const DEFAULT_BRANCH_PREFIX = "outfitter/";

/** `outfitter` and `outfitter/` both mean branches under `outfitter/`. Invalid input is undefined. */
export function normalizeBranchPrefix(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_BRANCH_PREFIX;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_BRANCH_PREFIX;
  if (
    /[\s\0~^:?*\[\\\]]/.test(trimmed) ||
    trimmed.includes("..") ||
    trimmed.startsWith("-") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("refs/")
  ) {
    return undefined;
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
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
  return branch.startsWith(prefix);
}
