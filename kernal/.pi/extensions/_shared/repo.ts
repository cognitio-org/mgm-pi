/**
 * The working directory's GitHub repository as Outfitter names it: `owner/name`, lowercased (the
 * `laptop.repo` Kernal sends with laptop memory calls; the API checks the same shape).
 */
import { remote } from "./git.ts";

export const REPO = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;

type RemoteLike = { host?: string; owner?: string; repo?: string };

/** `owner/name` of a github.com remote, lowercased, or undefined. */
export function githubRepo(r: RemoteLike | undefined): string | undefined {
  if (!r?.owner || !r.repo || (r.host ?? "").toLowerCase() !== "github.com") return undefined;
  const repo = `${r.owner}/${r.repo}`.toLowerCase();
  return REPO.test(repo) ? repo : undefined;
}

export type RepoOf = (cwd: string) => Promise<string | undefined>;

/** The cwd's GitHub repo, from `origin`, cached per directory for this process. */
export function cachedRepoOf(lookup: (cwd: string) => Promise<RemoteLike | undefined> = remote): RepoOf {
  const cache = new Map<string, Promise<string | undefined>>();
  return (cwd) => {
    let hit = cache.get(cwd);
    if (!hit) {
      hit = lookup(cwd).then(githubRepo, () => undefined);
      cache.set(cwd, hit);
    }
    return hit;
  };
}
