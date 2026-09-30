// What the New Floppy repository field offers for whatever the person has typed.
// A listed repository is a pick. A name the App cannot see can still be typed (a Floppy can
// point at any GitHub repository). Create is only offered when that owner is an account the
// App is installed on, organization or user.

import type { GithubAccount, GithubRepoSummary } from "../api/client.ts";

const NAME = /^[A-Za-z0-9_.-]+$/;

export function validOwner(owner: string): boolean {
  return NAME.test(owner) && owner !== "." && owner !== ".." && owner.length <= 39;
}

export function validRepoName(name: string): boolean {
  return NAME.test(name) && name !== "." && name !== ".." && !name.toLowerCase().endsWith(".git") && name.length <= 100;
}

/** `owner/repo`, a github.com URL, or `git@github.com:owner/repo.git`, as `owner/repo`. */
export function normalizeRepoInput(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(text);
  if (ssh?.[1] && ssh[2]) return `${ssh[1]}/${ssh[2]}`;
  if (text.includes("://") || /^(?:www\.)?github\.com\//i.test(text)) {
    try {
      const url = new URL(text.includes("://") ? text : `https://${text}`);
      if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return text;
      const parts = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "").split("/").filter(Boolean);
      if (parts[0] && parts[1]) return `${decodeURIComponent(parts[0])}/${decodeURIComponent(parts[1])}`;
    } catch {
      return text;
    }
  }
  const short = /^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(text);
  if (short?.[1] && short[2]) return `${short[1]}/${short[2]}`;
  return text;
}

export interface RepoMenuItem {
  kind: "none" | "repo" | "use" | "create";
  label: string;
  /** `owner/name`, or "" for no repository. */
  value: string;
}

const MENU_CAP = 50;

/** Empty query: no repository, then the most recently pushed repositories (already sorted).
 * A typed `owner/name` that is not in the list can be used as-is, and created when the App
 * is installed on that owner. */
export function repoMenu(query: string, repos: GithubRepoSummary[], accounts: GithubAccount[]): RepoMenuItem[] {
  const typed = query.trim();
  const normalized = normalizeRepoInput(typed);
  const q = normalized.toLowerCase();
  const items: RepoMenuItem[] = [];
  if (!q) {
    items.push({ kind: "none", label: "No repository", value: "" });
    for (const repo of repos.slice(0, MENU_CAP)) items.push({ kind: "repo", label: repo.fullName, value: repo.fullName });
    return items;
  }
  const needle = typed.toLowerCase();
  const matches = repos
    .filter((repo) => repo.fullName.toLowerCase().includes(q) || repo.fullName.toLowerCase().includes(needle))
    .slice(0, MENU_CAP);
  for (const repo of matches) items.push({ kind: "repo", label: repo.fullName, value: repo.fullName });
  const [owner, name] = normalized.split("/");
  const listed = repos.some((repo) => repo.fullName.toLowerCase() === normalized.toLowerCase());
  if (!listed && owner && name && !normalized.slice(owner.length + 1).includes("/") && validOwner(owner) && validRepoName(name)) {
    items.push({ kind: "use", label: `Use ${owner}/${name}`, value: `${owner}/${name}` });
    const account = accounts.find((row) => row.login.toLowerCase() === owner.toLowerCase());
    if (account) items.push({ kind: "create", label: `Create ${account.login}/${name}`, value: `${account.login}/${name}` });
  }
  return items;
}
