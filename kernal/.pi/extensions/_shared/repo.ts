/**
 * The working directory's GitHub repository as Outfitter names it: `owner/name`, lowercased (the
 * `laptop.repo` Kernal sends with laptop memory calls; the API checks the same shape).
 */
import { gitValue, remote } from "./git.ts";

export const REPO = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/;

type RemoteLike = { name?: string; host?: string; owner?: string; repo?: string };

/** `owner/name` of a github.com remote, lowercased, or undefined. */
export function githubRepo(r: RemoteLike | undefined): string | undefined {
  if (!r?.owner || !r.repo || (r.host ?? "").toLowerCase() !== "github.com") return undefined;
  const repo = `${r.owner}/${r.repo}`.toLowerCase();
  return REPO.test(repo) ? repo : undefined;
}

export type RepoOf = (cwd: string) => Promise<string | undefined>;

/**
 * The remote the laptop context names (owner decision, #354): the repo's `origin` (git finds the
 * repo from any subdirectory), whatever it points at, so a non-GitHub origin means no repo; with no
 * `origin`, the first GitHub remote, marked `fallback` so callers can say which one they used.
 */
export async function repoRemote(
  cwd: string,
  lookup: (cwd: string, name?: string) => Promise<RemoteLike | undefined> = remote,
  names: (cwd: string) => Promise<string[]> = async (c) => ((await gitValue(["remote"], { cwd: c })) ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
): Promise<(RemoteLike & { fallback?: true }) | undefined> {
  const origin = await lookup(cwd, "origin");
  if (origin) return origin;
  for (const name of await names(cwd)) {
    const r = await lookup(cwd, name);
    if (githubRepo(r)) return { ...r, name, fallback: true };
  }
  return undefined;
}

/** The repo line for /tape status and the admin page: the repo, and a note when it came from a
 * remote other than `origin` or there is none. */
export async function repoInfo(cwd: string, lookup?: Parameters<typeof repoRemote>[1], names?: Parameters<typeof repoRemote>[2]): Promise<{ repo?: string; note?: string }> {
  const r = await repoRemote(cwd, lookup, names).catch(() => undefined);
  const repo = githubRepo(r);
  if (!r) return { note: "not in a git repository with a GitHub remote" };
  if (!repo) return { note: `origin is not a GitHub repository (${r.host ?? "unknown host"}), so no repo` };
  return r.fallback ? { repo, note: `no origin remote; using ${r.name}` } : { repo };
}

/** The cwd's GitHub repo (repoRemote), cached per directory for this process. */
export function cachedRepoOf(lookup: (cwd: string) => Promise<RemoteLike | undefined> = (cwd) => repoRemote(cwd)): RepoOf {
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
