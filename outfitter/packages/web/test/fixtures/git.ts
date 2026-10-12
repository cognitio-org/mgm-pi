// #502: GitHub status and /changes answers for the git chips and the Changes tab's tests.
import type { GithubSessionPr, GithubSessionStatus, SessionChanges } from "../../src/api/client.ts";

export function pr(over: Partial<GithubSessionPr> = {}): GithubSessionPr {
  return {
    number: 503,
    url: "https://github.com/o/r/pull/503",
    title: "Compare tokens in constant time",
    draft: false,
    base: "main",
    headSha: "b40f1d2aaaaaaaa",
    checks: [],
    checkSummary: { passed: 3, failed: 0, pending: 0, total: 3, state: "pass" },
    review: "approved",
    mergeable: true,
    mergeableState: "clean",
    ...over,
  };
}

export function status(over: Partial<GithubSessionStatus> = {}): GithubSessionStatus {
  return {
    connected: true,
    repo: "o/r",
    branch: "claude/x",
    baseBranch: "main",
    pulls: [],
    branchPull: null,
    diff: { additions: 5, deletions: 1, ahead: 2, behind: 0, source: "compare" },
    mergeAllowed: true,
    pr: null,
    ...over,
  };
}

export function changes(over: Partial<SessionChanges> = {}): SessionChanges {
  return {
    source: "github",
    base: "main",
    branch: "claude/x",
    ahead: 2,
    behind: 0,
    truncated: false,
    files: [{ path: "src/a.ts", status: "M", additions: 4, deletions: 1, patch: "@@ -1,2 +1,3 @@\n a\n-b\n+B\n+c" }],
    ...over,
  };
}

