// Repo and GitHub-broker facts for the session status line. The floppy's checkout
// (session.repo) and the broker target (session.github.repo) used to each say
// "no repository", so an empty floppy printed it twice. One phrase owns that fact.

import type { SessionDetail } from "../api/client.ts";

export interface GithubCluster {
  /** "owner/repo @ branch", or null when neither side has a repository. */
  repo: string | null;
  noRepository: boolean;
  credential: string;
  onBehalfOf: string | null;
  mergeLabel: "merge allowed" | "merge off";
  /** The broker is pinned to the floppy's branch. */
  branchOnly: boolean;
}

type SessionRepoFields = Pick<SessionDetail, "repo" | "branch" | "github">;

export function formatRepo(repo: string | null | undefined, branch: string | null | undefined): string | null {
  if (!repo) return null;
  return branch ? `${repo} @ ${branch}` : repo;
}

/** Null when this floppy has no GitHub broker block. The chip then owns the repo words. */
export function githubCluster(session: SessionRepoFields | null | undefined): GithubCluster | null {
  const gh = session?.github;
  if (!gh) return null;
  const repo = gh.repo ? formatRepo(gh.repo, gh.branch) : formatRepo(session?.repo, session?.branch);
  return {
    repo,
    noRepository: !repo,
    credential:
      gh.credential === "session"
        ? "session token"
        : gh.credential === "default"
          ? "shared token"
          : gh.credential === "app"
            ? gh.appSlug
              ? `acting as ${gh.appSlug}[bot]`
              : "acting as the GitHub App"
            : "no token",
    onBehalfOf: gh.onBehalfOf,
    mergeLabel: gh.merge ? "merge allowed" : "merge off",
    branchOnly: Boolean(gh.repo),
  };
}

/** Repo words for the status line when the GitHub chip is not already saying them.
 * "no repository" only when there is no chip at all. Both are shown when the checkout
 * repo or branch differs from the broker target, including a branch on only one side. */
export function looseRepoClause(session: SessionRepoFields | null | undefined): string | null {
  if (!session) return null;
  if (!session.github) return formatRepo(session.repo, session.branch) ?? "no repository";
  const checkout = formatRepo(session.repo, session.branch);
  const broker = formatRepo(session.github.repo, session.github.branch);
  if (!checkout || !broker || checkout === broker) return null;
  return checkout;
}
