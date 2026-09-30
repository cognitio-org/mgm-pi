// Repositories the Outfitter GitHub App can reach, for the browser.
//
// A Drive's installation token stays scoped to one repository and to the permissions in
// github-app.ts. This catalog mints its own short-lived tokens inside the API process: metadata
// to list, contents and pull requests to describe one repository, and Administration only for
// the create call. None of those tokens are returned to the browser or sent to a Drive.
//
// Creating a repository asks for `administration: write` (GitHub's "repository creation,
// deletion, settings"). An installation that has not granted that answers 403 here; the Drive
// token is not widened to paper over it. A repository this App creates is added to the
// installation, so a later Floppy can clone it. `auto_init` gives that clone a default branch.

import { classifyTokenRequest422, githubAppJwt, GITHUB_APP_ID_SECRET, GITHUB_APP_KEY_SECRET } from "./github-app.ts";
import { parseSessionRepo } from "./session-repo.ts";

const LIST_TTL_MS = 60_000;
const FAILURE_TTL_MS = 15_000;
const DETAIL_TTL_MS = 30_000;
const STATUS_TTL_MS = 30_000;
const REFRESH_EARLY_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;
const MAX_PAGES = 10;
const MAX_PULLS = 30;

const NAME = /^[A-Za-z0-9_.-]+$/;
const REF = /^[A-Za-z0-9._/-]+$/;

const LIST_PERMISSIONS = { metadata: "read" } as const;
const READ_PERMISSIONS = { metadata: "read", contents: "read", pull_requests: "read" } as const;
const CREATE_PERMISSIONS = { administration: "write", metadata: "read" } as const;

type PermissionSet = Record<string, "read" | "write">;

export interface GithubAccount {
  login: string;
  type: "Organization" | "User";
}

export interface GithubRepoSummary {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  description: string | null;
  defaultBranch: string | null;
  pushedAt: string | null;
  htmlUrl: string;
  language: string | null;
  account: string;
  accountType: "Organization" | "User";
}

export interface GithubCatalogSnapshot {
  configured: boolean;
  /** Set when `configured` is false. */
  reason?: "not-configured" | "misconfigured" | "unavailable";
  /** An installation or a page cap stopped the list early. */
  truncated: boolean;
  accounts: GithubAccount[];
  repos: GithubRepoSummary[];
}

export interface GithubPull {
  number: number;
  title: string;
  url: string;
  draft: boolean;
  author: string | null;
  updatedAt: string | null;
  head: string;
  base: string;
  additions: number | null;
  deletions: number | null;
}

export interface GithubCommit {
  sha: string;
  url: string;
  message: string;
  author: string | null;
  date: string | null;
}

export interface GithubRepoDetail extends GithubRepoSummary {
  openPulls: GithubPull[];
  lastCommit: GithubCommit | null;
  /** Weekly commit counts, oldest first. `pending` while GitHub is still computing them. */
  contributions: { weeks: number[] } | { pending: true } | null;
}

export interface GithubDiff {
  additions: number;
  deletions: number;
  ahead?: number;
  behind?: number;
  source: "pull" | "compare";
  /** GitHub returned only part of the file list, so the counts are a lower bound. */
  partial?: boolean;
}

export type GithubStatusReason =
  | "no-repository"
  | "invalid"
  | "not-configured"
  | "misconfigured"
  | "not-installed"
  | "unavailable";

export interface GithubSessionStatus {
  connected: boolean;
  reason?: GithubStatusReason;
  repo: string | null;
  branch: string | null;
  baseBranch: string | null;
  pulls: GithubPull[];
  branchPull: GithubPull | null;
  diff: GithubDiff | null;
}

export interface GithubCreateInput {
  owner: string;
  name: string;
  private?: boolean;
  description?: string;
}

export type GithubCreateResult =
  | { ok: true; repo: GithubRepoSummary }
  | { ok: false; status: 400 | 403 | 404 | 409 | 503; error: string };

export type GithubDetailResult =
  | { ok: true; repo: GithubRepoDetail }
  | { ok: false; status: 400 | 404 | 503; error: string };

interface InstallationRef {
  id: number;
  login: string;
  type: "Organization" | "User";
}

interface CachedList {
  at: number;
  ttl: number;
  snapshot: GithubCatalogSnapshot;
  installations: InstallationRef[];
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

type Creds =
  | { ok: true; appId: string; privateKey: string }
  | { ok: false; reason: "not-configured" | "misconfigured" | "unavailable" };

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "Error";
}

function permissionKey(permissions: PermissionSet): string {
  return Object.entries(permissions)
    .map(([name, level]) => `${name}=${level}`)
    .sort()
    .join(",");
}

export function validOwner(owner: string): boolean {
  return NAME.test(owner) && owner !== "." && owner !== ".." && owner.length <= 39;
}

export function validRepoName(name: string): boolean {
  return NAME.test(name) && name !== "." && name !== ".." && !name.toLowerCase().endsWith(".git") && name.length <= 100;
}

function clipText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\r\n\t]+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function countOf(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.floor(value), 10_000_000);
}

function iso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Only https://github.com links leave the API. Anything else becomes the canonical repo URL. */
export function githubWebUrl(value: unknown, owner: string, repo: string): string {
  const fallback = `https://github.com/${owner}/${repo}`;
  if (typeof value !== "string") return fallback;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "github.com") return url.toString();
  } catch {
    // fall through
  }
  return fallback;
}

function pullUrl(value: unknown, owner: string, repo: string, number: number): string {
  const fallback = `https://github.com/${owner}/${repo}/pull/${number}`;
  if (typeof value !== "string") return fallback;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "github.com") return url.toString();
  } catch {
    // fall through
  }
  return fallback;
}

function commitUrl(value: unknown, owner: string, repo: string, sha: string): string {
  const fallback = `https://github.com/${owner}/${repo}/commit/${sha}`;
  if (typeof value !== "string") return fallback;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname === "github.com") return url.toString();
  } catch {
    // fall through
  }
  return fallback;
}

/** One entry, this owner and repo, nothing else. GitHub owner and repo names are case-insensitive.
 * A same-named repository on another account does not count. */
function exactlyThisRepo(list: { full_name?: unknown }[] | undefined, owner: string, repo: string): boolean {
  if (!list || list.length !== 1) return false;
  const full = list[0]?.full_name;
  return typeof full === "string" && full.toLowerCase() === `${owner}/${repo}`.toLowerCase();
}

/** Follow only a next link whose path is the list we asked for. A prefix match would also
 * accept `/app/installations/1` and a `..` URL that fetch normalizes onto a token route. */
function nextLink(res: Response, pathname: string): string | undefined {
  const link = res.headers.get("link");
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part);
    const raw = match?.[1];
    if (!raw || raw.includes("..") || raw.includes("\\")) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.origin !== "https://api.github.com" || url.pathname !== pathname) continue;
    if (url.username || url.password) continue;
    return url.toString();
  }
  return undefined;
}

function safeRef(ref: string): boolean {
  return REF.test(ref) && !ref.includes("..") && !ref.startsWith("-") && ref.length <= 250;
}

function emptyStatus(
  reason: GithubStatusReason,
  repo: string | null,
  branch: string | null,
  baseBranch: string | null,
): GithubSessionStatus {
  return { connected: false, reason, repo, branch, baseBranch, pulls: [], branchPull: null, diff: null };
}

function unconfiguredMessage(reason: "not-configured" | "misconfigured" | "unavailable"): { status: 400 | 503; error: string } {
  if (reason === "misconfigured") return { status: 400, error: "the GitHub App secrets aren't usable" };
  if (reason === "unavailable") return { status: 503, error: "GitHub is unavailable" };
  return { status: 400, error: "the GitHub App isn't set up" };
}

async function githubMessage(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { message?: unknown; errors?: { message?: unknown }[] };
    const extra = Array.isArray(body.errors)
      ? body.errors
          .map((row) => (typeof row?.message === "string" ? row.message : ""))
          .filter(Boolean)
          .join("; ")
      : "";
    const message = typeof body.message === "string" ? body.message : "";
    const text = [message, extra].filter(Boolean).join(": ");
    return text ? text.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

function nameTaken(message: string | undefined): boolean {
  return /already exists/i.test(message ?? "");
}

export class GithubCatalog {
  private remembered: CachedList | undefined;
  private listInflight: Promise<{ snapshot: GithubCatalogSnapshot; installations: InstallationRef[] }> | undefined;
  private epoch = 0;
  private readonly tokens = new Map<string, CachedToken>();
  private readonly details = new Map<string, { at: number; value: GithubDetailResult }>();
  private readonly statuses = new Map<string, { at: number; value: GithubSessionStatus }>();
  private readonly read: (secretName: string) => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(read: (secretName: string) => Promise<string>, fetchImpl: typeof fetch = fetch, now: () => number = Date.now) {
    this.read = read;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async list(opts?: { fresh?: boolean }): Promise<GithubCatalogSnapshot> {
    const loaded = await this.loadListed(opts?.fresh);
    return loaded.snapshot;
  }

  /** The snapshot and the installations that produced it, from this call rather than from
   * `remembered`. A refresh can clear that cache while this call is in flight. */
  private loadListed(fresh?: boolean): Promise<{ snapshot: GithubCatalogSnapshot; installations: InstallationRef[] }> {
    if (fresh) {
      this.epoch += 1;
      this.remembered = undefined;
    } else if (this.remembered && this.now() - this.remembered.at < this.remembered.ttl) {
      return Promise.resolve({ snapshot: this.remembered.snapshot, installations: this.remembered.installations });
    } else if (this.listInflight) {
      return this.listInflight;
    }
    const epoch = this.epoch;
    const run = this.fetchList()
      .then((loaded) => {
        const result = { snapshot: loaded.snapshot, installations: loaded.installations };
        if (epoch === this.epoch) this.remembered = { ...loaded, at: this.now() };
        return result;
      })
      .finally(() => {
        if (this.listInflight === run) this.listInflight = undefined;
      });
    this.listInflight = run;
    return run;
  }

  async detail(owner: string, name: string): Promise<GithubDetailResult> {
    if (!validOwner(owner) || !validRepoName(name)) return { ok: false, status: 400, error: "invalid repository" };
    const key = `${owner}/${name}`.toLowerCase();
    const hit = this.details.get(key);
    if (hit && this.now() - hit.at < DETAIL_TTL_MS) return hit.value;
    const value = await this.fetchDetail(owner, name);
    const ttl = value.ok || value.status !== 503 ? DETAIL_TTL_MS : FAILURE_TTL_MS;
    this.details.set(key, { at: this.now() - (DETAIL_TTL_MS - ttl), value });
    return value;
  }

  async create(input: GithubCreateInput): Promise<GithubCreateResult> {
    const owner = input.owner?.trim() ?? "";
    const name = input.name?.trim() ?? "";
    if (!validOwner(owner) || !validRepoName(name)) {
      return { ok: false, status: 400, error: "owner and name must be GitHub names, like acme/widget" };
    }
    if (input.private !== undefined && typeof input.private !== "boolean") {
      return { ok: false, status: 400, error: "private must be true or false" };
    }
    const description = typeof input.description === "string" ? clipText(input.description, 350) ?? "" : "";
    const loaded = await this.loadListed();
    if (!loaded.snapshot.configured) {
      const reason = loaded.snapshot.reason ?? "not-configured";
      const mapped = unconfiguredMessage(reason);
      return { ok: false, status: mapped.status, error: mapped.error };
    }
    const installation = loaded.installations.find((row) => row.login.toLowerCase() === owner.toLowerCase());
    if (!installation) {
      return { ok: false, status: 404, error: `the GitHub App isn't installed on ${owner}` };
    }
    const creds = await this.credentials();
    if (!creds.ok) {
      const mapped = unconfiguredMessage(creds.reason);
      return { ok: false, status: mapped.status, error: mapped.error };
    }
    let jwt: string;
    try {
      jwt = githubAppJwt(creds.appId, creds.privateKey, Math.floor(this.now() / 1000));
    } catch (err) {
      console.warn(`[github-catalog] could not sign the app jwt: ${errorName(err)}`);
      return { ok: false, status: 503, error: "GitHub is unavailable" };
    }
    const minted = await this.installationToken(installation.id, jwt, CREATE_PERMISSIONS);
    if (!minted.ok) {
      if (minted.reason === "permissions") {
        return {
          ok: false,
          status: 403,
          error: `the GitHub App needs Administration permission on ${installation.login} to create a repository`,
        };
      }
      return { ok: false, status: 503, error: "GitHub is unavailable" };
    }
    const url =
      installation.type === "Organization"
        ? `https://api.github.com/orgs/${encodeURIComponent(installation.login)}/repos`
        : "https://api.github.com/user/repos";
    const res = await this.call(url, minted.token, {
      method: "POST",
      body: JSON.stringify({
        name,
        private: input.private !== false,
        auto_init: true,
        ...(description ? { description } : {}),
      }),
    });
    if (!res) return { ok: false, status: 503, error: "GitHub is unavailable" };
    if (res.status === 422) {
      const message = await githubMessage(res);
      if (nameTaken(message)) return { ok: false, status: 409, error: `${installation.login}/${name} already exists` };
      return { ok: false, status: 400, error: message || "GitHub refused that repository name" };
    }
    if (res.status === 403) {
      const message = await githubMessage(res);
      console.warn(`[github-catalog] create repository returned 403: ${message ?? "no message"}`);
      return {
        ok: false,
        status: 403,
        error: `the GitHub App needs Administration permission on ${installation.login} to create a repository`,
      };
    }
    if (!res.ok) {
      console.warn(`[github-catalog] create repository returned ${res.status}`);
      return { ok: false, status: 503, error: "GitHub is unavailable" };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, status: 503, error: "GitHub is unavailable" };
    }
    const repo = this.readRepo(body, installation);
    if (!repo) return { ok: false, status: 503, error: "GitHub is unavailable" };
    // The list token's repository set was fixed when it was minted. On a selected-repositories
    // installation that token cannot see the repository this call just created.
    this.epoch += 1;
    this.remembered = undefined;
    this.tokens.delete(`${installation.id}:${permissionKey(LIST_PERMISSIONS)}:*`);
    return { ok: true, repo };
  }

  async sessionStatus(session: {
    repo: string | null;
    branch?: string | null;
    baseBranch?: string | null;
  }): Promise<GithubSessionStatus> {
    const branch = session.branch ?? null;
    const baseBranch = session.baseBranch ?? null;
    if (!session.repo) return emptyStatus("no-repository", null, branch, baseBranch);
    const parsed = parseSessionRepo(session.repo);
    if (!parsed || !validOwner(parsed.owner) || !validRepoName(parsed.repo)) {
      return emptyStatus("invalid", session.repo, branch, baseBranch);
    }
    const repo = `${parsed.owner}/${parsed.repo}`;
    const key = `${repo.toLowerCase()}:${branch ?? ""}:${baseBranch ?? ""}`;
    const hit = this.statuses.get(key);
    if (hit && this.now() - hit.at < STATUS_TTL_MS) return hit.value;
    const value = await this.fetchStatus(parsed.owner, parsed.repo, branch, baseBranch);
    // A blip is not "the App cannot see this repository". Keep it briefly, same as a detail 503.
    const transient = !value.connected && value.reason === "unavailable";
    const ttl = transient ? FAILURE_TTL_MS : STATUS_TTL_MS;
    this.statuses.set(key, { at: this.now() - (STATUS_TTL_MS - ttl), value });
    return value;
  }

  private async fetchList(): Promise<{ snapshot: GithubCatalogSnapshot; installations: InstallationRef[]; ttl: number }> {
    const creds = await this.credentials();
    if (!creds.ok) {
      return {
        ttl: creds.reason === "unavailable" ? FAILURE_TTL_MS : LIST_TTL_MS,
        installations: [],
        snapshot: { configured: false, reason: creds.reason, truncated: false, accounts: [], repos: [] },
      };
    }
    let jwt: string;
    try {
      jwt = githubAppJwt(creds.appId, creds.privateKey, Math.floor(this.now() / 1000));
    } catch (err) {
      console.warn(`[github-catalog] could not sign the app jwt: ${errorName(err)}`);
      return {
        ttl: FAILURE_TTL_MS,
        installations: [],
        snapshot: { configured: false, reason: "unavailable", truncated: false, accounts: [], repos: [] },
      };
    }
    const found = await this.installations(jwt);
    if (!found) {
      return {
        ttl: FAILURE_TTL_MS,
        installations: [],
        snapshot: { configured: false, reason: "unavailable", truncated: false, accounts: [], repos: [] },
      };
    }
    const repos: GithubRepoSummary[] = [];
    const seen = new Set<string>();
    let truncated = found.truncated;
    for (const installation of found.installations) {
      const minted = await this.installationToken(installation.id, jwt, LIST_PERMISSIONS);
      if (!minted.ok) {
        truncated = true;
        continue;
      }
      const page = await this.repositories(minted.token, installation);
      if (!page) {
        truncated = true;
        continue;
      }
      truncated = truncated || page.truncated;
      for (const repo of page.repos) {
        const id = repo.fullName.toLowerCase();
        if (seen.has(id)) continue;
        seen.add(id);
        repos.push(repo);
      }
    }
    repos.sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? "") || a.fullName.localeCompare(b.fullName));
    const accounts = found.installations
      .map((row) => ({ login: row.login, type: row.type }))
      .sort((a, b) => a.login.localeCompare(b.login));
    return {
      ttl: LIST_TTL_MS,
      installations: found.installations,
      snapshot: { configured: true, truncated, accounts, repos },
    };
  }

  private async fetchDetail(owner: string, name: string): Promise<GithubDetailResult> {
    const opened = await this.openRepo(owner, name, READ_PERMISSIONS);
    if (!opened.ok) return opened;
    const { token, installation } = opened;
    const [repoRes, pullsRes, commitsRes, statsRes] = await Promise.all([
      this.call(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, token),
      this.call(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=open&per_page=${MAX_PULLS}&sort=updated&direction=desc`,
        token,
      ),
      this.call(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits?per_page=1`,
        token,
      ),
      this.call(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/stats/participation`,
        token,
      ),
    ]);
    if (!repoRes?.ok) return { ok: false, status: repoRes?.status === 404 ? 404 : 503, error: "the GitHub App can't reach this repository" };
    let repoBody: unknown;
    try {
      repoBody = await repoRes.json();
    } catch {
      return { ok: false, status: 503, error: "GitHub is unavailable" };
    }
    const summary = this.readRepo(repoBody, installation);
    if (!summary) return { ok: false, status: 404, error: "the GitHub App can't reach this repository" };
    if (!pullsRes?.ok) return { ok: false, status: 503, error: "GitHub is unavailable" };
    const listed = await this.readPulls(pullsRes, owner, name);
    if (!listed) return { ok: false, status: 503, error: "GitHub is unavailable" };
    const openPulls = await Promise.all(listed.map((pull) => this.pullCounts(token, owner, name, pull)));
    const lastCommit = commitsRes?.ok ? await this.readCommit(commitsRes, owner, name) : null;
    const contributions = await this.readContributions(statsRes);
    return { ok: true, repo: { ...summary, openPulls, lastCommit, contributions } };
  }

  private async fetchStatus(owner: string, name: string, branch: string | null, baseBranch: string | null): Promise<GithubSessionStatus> {
    const repo = `${owner}/${name}`;
    const opened = await this.openRepo(owner, name, READ_PERMISSIONS);
    if (!opened.ok) return emptyStatus(opened.reason, repo, branch, baseBranch);
    const pullsRes = await this.call(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?state=open&per_page=${MAX_PULLS}&sort=updated&direction=desc`,
      opened.token,
    );
    if (!pullsRes?.ok) return emptyStatus("unavailable", repo, branch, baseBranch);
    const listed = await this.readPulls(pullsRes, owner, name);
    if (!listed) return emptyStatus("unavailable", repo, branch, baseBranch);
    const match = branch ? listed.find((pull) => pull.head === branch) : undefined;
    const counted = match ? await this.pullCounts(opened.token, owner, name, match) : undefined;
    const pulls = counted ? listed.map((pull) => (pull.number === counted.number ? counted : pull)) : listed;
    const branchPull = counted ?? null;
    const ordered = branchPull ? [branchPull, ...pulls.filter((pull) => pull.number !== branchPull.number)] : pulls;
    let diff: GithubDiff | null = null;
    if (branchPull && branchPull.additions !== null && branchPull.deletions !== null) {
      diff = { additions: branchPull.additions, deletions: branchPull.deletions, source: "pull" };
    } else if (branch && baseBranch && safeRef(branch) && safeRef(baseBranch)) {
      diff = await this.compare(opened.token, owner, name, baseBranch, branch);
    }
    return { connected: true, repo, branch, baseBranch, pulls: ordered, branchPull, diff };
  }

  private async compare(token: string, owner: string, name: string, base: string, head: string): Promise<GithubDiff | null> {
    const basehead = `${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
    const res = await this.call(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/compare/${basehead}`,
      token,
    );
    if (!res || res.status === 404) return null;
    if (!res.ok) {
      console.warn(`[github-catalog] compare returned ${res.status}`);
      return null;
    }
    let body: { ahead_by?: unknown; behind_by?: unknown; files?: unknown };
    try {
      body = (await res.json()) as { ahead_by?: unknown; behind_by?: unknown; files?: unknown };
    } catch {
      return null;
    }
    const files = Array.isArray(body.files) ? body.files : [];
    let additions = 0;
    let deletions = 0;
    for (const file of files) {
      if (!file || typeof file !== "object") continue;
      const row = file as { additions?: unknown; deletions?: unknown };
      additions += countOf(row.additions) ?? 0;
      deletions += countOf(row.deletions) ?? 0;
    }
    if (additions === 0 && deletions === 0 && files.length === 0) return null;
    const ahead = countOf(body.ahead_by);
    const behind = countOf(body.behind_by);
    return {
      additions,
      deletions,
      ...(ahead !== null ? { ahead } : {}),
      ...(behind !== null ? { behind } : {}),
      source: "compare",
      ...(files.length >= 300 ? { partial: true } : {}),
    };
  }

  /** App JWT plus an installation token scoped to this one repository. */
  private async openRepo(
    owner: string,
    name: string,
    permissions: PermissionSet,
  ): Promise<
    | { ok: true; token: string; installation: InstallationRef }
    | { ok: false; status: 404 | 503; error: string; reason: GithubStatusReason }
  > {
    const creds = await this.credentials();
    if (!creds.ok) {
      const mapped = unconfiguredMessage(creds.reason);
      return { ok: false, status: mapped.status === 503 ? 503 : 404, error: mapped.error, reason: creds.reason };
    }
    let jwt: string;
    try {
      jwt = githubAppJwt(creds.appId, creds.privateKey, Math.floor(this.now() / 1000));
    } catch (err) {
      console.warn(`[github-catalog] could not sign the app jwt: ${errorName(err)}`);
      return { ok: false, status: 503, error: "GitHub is unavailable", reason: "unavailable" };
    }
    const lookedUp = await this.repoInstallation(jwt, owner, name);
    if (!lookedUp.ok) {
      return lookedUp.reason === "unavailable"
        ? { ok: false, status: 503, error: "GitHub is unavailable", reason: "unavailable" }
        : { ok: false, status: 404, error: "the GitHub App can't reach this repository", reason: "not-installed" };
    }
    const installation = lookedUp.installation;
    const minted = await this.installationToken(installation.id, jwt, permissions, { owner, name });
    if (!minted.ok && minted.reason === "permissions") {
      const reduced = await this.installationToken(
        installation.id,
        jwt,
        { metadata: "read", pull_requests: "read" },
        { owner, name },
      );
      if (reduced.ok) return { ok: true, token: reduced.token, installation };
    }
    if (!minted.ok) {
      return minted.reason === "not-installed"
        ? { ok: false, status: 404, error: "the GitHub App can't reach this repository", reason: "not-installed" }
        : { ok: false, status: 503, error: "GitHub is unavailable", reason: "unavailable" };
    }
    return { ok: true, token: minted.token, installation };
  }

  private async credentials(): Promise<Creds> {
    let appId = "";
    let privateKey = "";
    try {
      [appId, privateKey] = await Promise.all([this.read(GITHUB_APP_ID_SECRET), this.read(GITHUB_APP_KEY_SECRET)]);
    } catch (err) {
      console.warn(`[github-catalog] app secret read failed: ${errorName(err)}`);
      return { ok: false, reason: "unavailable" };
    }
    if (!appId.trim() && !privateKey.trim()) return { ok: false, reason: "not-configured" };
    if (!/^\d+$/.test(appId.trim()) || !privateKey.includes("PRIVATE KEY")) return { ok: false, reason: "misconfigured" };
    return { ok: true, appId: appId.trim(), privateKey };
  }

  private async installations(jwt: string): Promise<{ installations: InstallationRef[]; truncated: boolean } | undefined> {
    const installations: InstallationRef[] = [];
    let url: string | undefined = "https://api.github.com/app/installations?per_page=100";
    let pages = 0;
    while (url && pages < MAX_PAGES) {
      pages += 1;
      const res = await this.call(url, jwt);
      if (!res?.ok) {
        console.warn(`[github-catalog] installations returned ${res?.status ?? "no response"}`);
        return undefined;
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return undefined;
      }
      if (!Array.isArray(body)) return undefined;
      for (const row of body) {
        const parsed = this.readInstallation(row);
        if (parsed) installations.push(parsed);
      }
      url = nextLink(res, "/app/installations");
    }
    return { installations, truncated: Boolean(url) };
  }

  private readInstallation(row: unknown): InstallationRef | undefined {
    if (!row || typeof row !== "object") return undefined;
    const item = row as { id?: unknown; suspended_at?: unknown; account?: { login?: unknown; type?: unknown } };
    if (typeof item.suspended_at === "string" && item.suspended_at) return undefined;
    if (typeof item.id !== "number" || !Number.isSafeInteger(item.id) || item.id <= 0) return undefined;
    const login = item.account?.login;
    const type = item.account?.type;
    if (typeof login !== "string" || !validOwner(login)) return undefined;
    if (type !== "Organization" && type !== "User") return undefined;
    return { id: item.id, login, type };
  }

  private async repositories(
    token: string,
    installation: InstallationRef,
  ): Promise<{ repos: GithubRepoSummary[]; truncated: boolean } | undefined> {
    const repos: GithubRepoSummary[] = [];
    let url: string | undefined = "https://api.github.com/installation/repositories?per_page=100";
    let pages = 0;
    while (url && pages < MAX_PAGES) {
      pages += 1;
      const res = await this.call(url, token);
      if (!res?.ok) {
        console.warn(`[github-catalog] repository list returned ${res?.status ?? "no response"}`);
        return undefined;
      }
      let body: { repositories?: unknown };
      try {
        body = (await res.json()) as { repositories?: unknown };
      } catch {
        return undefined;
      }
      if (!Array.isArray(body.repositories)) return undefined;
      for (const row of body.repositories) {
        const repo = this.readRepo(row, installation);
        if (repo) repos.push(repo);
      }
      url = nextLink(res, "/installation/repositories");
    }
    return { repos, truncated: Boolean(url) };
  }

  private readRepo(row: unknown, installation: InstallationRef): GithubRepoSummary | undefined {
    if (!row || typeof row !== "object") return undefined;
    const item = row as {
      full_name?: unknown;
      private?: unknown;
      description?: unknown;
      default_branch?: unknown;
      pushed_at?: unknown;
      html_url?: unknown;
      language?: unknown;
    };
    if (typeof item.full_name !== "string") return undefined;
    const parts = item.full_name.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1] || !validOwner(parts[0]) || !validRepoName(parts[1])) return undefined;
    return {
      fullName: `${parts[0]}/${parts[1]}`,
      owner: parts[0],
      name: parts[1],
      private: item.private === true,
      description: clipText(item.description, 300),
      defaultBranch: typeof item.default_branch === "string" && safeRef(item.default_branch) ? item.default_branch : null,
      pushedAt: iso(item.pushed_at),
      htmlUrl: githubWebUrl(item.html_url, parts[0], parts[1]),
      language: clipText(item.language, 40),
      account: installation.login,
      accountType: installation.type,
    };
  }

  /** Undefined when the body is not a list. An empty list is a real "no open pull requests". */
  private async readPulls(res: Response, owner: string, name: string): Promise<GithubPull[] | undefined> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return undefined;
    }
    if (!Array.isArray(body)) return undefined;
    const pulls: GithubPull[] = [];
    for (const row of body) {
      const pull = this.readPull(row, owner, name);
      if (pull) pulls.push(pull);
      if (pulls.length >= MAX_PULLS) break;
    }
    return pulls;
  }

  /** The list route omits additions and deletions. They are on the single pull request. */
  private async pullCounts(token: string, owner: string, name: string, pull: GithubPull): Promise<GithubPull> {
    const res = await this.call(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${pull.number}`,
      token,
    );
    if (!res?.ok) return pull;
    let body: { additions?: unknown; deletions?: unknown };
    try {
      body = (await res.json()) as { additions?: unknown; deletions?: unknown };
    } catch {
      return pull;
    }
    const additions = countOf(body.additions);
    const deletions = countOf(body.deletions);
    if (additions === null || deletions === null) return pull;
    return { ...pull, additions, deletions };
  }

  private readPull(row: unknown, owner: string, name: string): GithubPull | undefined {
    if (!row || typeof row !== "object") return undefined;
    const item = row as {
      number?: unknown;
      title?: unknown;
      html_url?: unknown;
      draft?: unknown;
      user?: { login?: unknown } | null;
      updated_at?: unknown;
      head?: { ref?: unknown; repo?: { full_name?: unknown } | null };
      base?: { ref?: unknown };
    };
    if (typeof item.number !== "number" || !Number.isSafeInteger(item.number) || item.number <= 0) return undefined;
    const title = clipText(item.title, 200);
    const head = typeof item.head?.ref === "string" ? item.head.ref : "";
    const base = typeof item.base?.ref === "string" ? item.base.ref : "";
    if (!title || !head || !base) return undefined;
    const headRepo = item.head?.repo?.full_name;
    if (typeof headRepo === "string" && headRepo.toLowerCase() !== `${owner}/${name}`.toLowerCase()) return undefined;
    return {
      number: item.number,
      title,
      url: pullUrl(item.html_url, owner, name, item.number),
      draft: item.draft === true,
      author: clipText(item.user?.login, 80),
      updatedAt: iso(item.updated_at),
      head,
      base,
      additions: null,
      deletions: null,
    };
  }

  private async readCommit(res: Response, owner: string, name: string): Promise<GithubCommit | null> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return null;
    }
    const row = Array.isArray(body) ? body[0] : undefined;
    if (!row || typeof row !== "object") return null;
    const item = row as {
      sha?: unknown;
      html_url?: unknown;
      author?: { login?: unknown } | null;
      commit?: { message?: unknown; author?: { name?: unknown; date?: unknown } };
    };
    if (typeof item.sha !== "string" || !/^[0-9a-f]{7,40}$/i.test(item.sha)) return null;
    const firstLine = typeof item.commit?.message === "string" ? item.commit.message.split(/\r?\n/, 1)[0] : item.commit?.message;
    const message = clipText(firstLine, 140);
    if (!message) return null;
    return {
      sha: item.sha,
      url: commitUrl(item.html_url, owner, name, item.sha),
      message,
      author: clipText(item.author?.login, 80) ?? clipText(item.commit?.author?.name, 80),
      date: iso(item.commit?.author?.date),
    };
  }

  private async readContributions(res: Response | undefined): Promise<GithubRepoDetail["contributions"]> {
    if (!res) return null;
    if (res.status === 202) return { pending: true };
    if (!res.ok) return null;
    let body: { all?: unknown };
    try {
      body = (await res.json()) as { all?: unknown };
    } catch {
      return null;
    }
    if (!Array.isArray(body.all) || body.all.length === 0 || body.all.length > 60) return null;
    const weeks: number[] = [];
    for (const value of body.all) {
      const count = countOf(value);
      if (count === null) return null;
      weeks.push(count);
    }
    return { weeks };
  }

  private async repoInstallation(
    jwt: string,
    owner: string,
    name: string,
  ): Promise<{ ok: true; installation: InstallationRef } | { ok: false; reason: "not-installed" | "unavailable" }> {
    const res = await this.call(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
      jwt,
    );
    // A missing installation is 404. A dropped connection or a 5xx is not "the App isn't here".
    if (!res) return { ok: false, reason: "unavailable" };
    if (res.status === 404) return { ok: false, reason: "not-installed" };
    if (!res.ok) {
      console.warn(`[github-catalog] installation lookup returned ${res.status}`);
      return { ok: false, reason: "unavailable" };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    const installation = this.readInstallation(body);
    return installation ? { ok: true, installation } : { ok: false, reason: "not-installed" };
  }

  private async installationToken(
    installationId: number,
    jwt: string,
    permissions: PermissionSet,
    repository?: { owner: string; name: string },
  ): Promise<{ ok: true; token: string } | { ok: false; reason: "permissions" | "not-installed" | "unavailable"; message?: string }> {
    const scope = repository ? `${repository.owner}/${repository.name}`.toLowerCase() : "*";
    const key = `${installationId}:${permissionKey(permissions)}:${scope}`;
    const hit = this.tokens.get(key);
    if (hit && hit.expiresAtMs - this.now() > REFRESH_EARLY_MS) return { ok: true, token: hit.token };
    const body: { permissions: PermissionSet; repositories?: string[] } = { permissions };
    if (repository) body.repositories = [repository.name];
    const res = await this.call(`https://api.github.com/app/installations/${installationId}/access_tokens`, jwt, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!res) return { ok: false, reason: "unavailable" };
    if (res.status === 422) {
      const message = await githubMessage(res);
      const kind = classifyTokenRequest422(message);
      console.warn(`[github-catalog] installation token returned 422 (${kind})`);
      if (kind === "repository") return { ok: false, reason: "not-installed" };
      if (kind === "permissions") return { ok: false, reason: "permissions", message };
      return { ok: false, reason: "unavailable", message };
    }
    if (res.status === 404) return { ok: false, reason: "not-installed" };
    if (!res.ok) {
      console.warn(`[github-catalog] installation token returned ${res.status}`);
      return { ok: false, reason: "unavailable" };
    }
    let parsed: { token?: unknown; expires_at?: unknown; repositories?: { full_name?: unknown }[] };
    try {
      parsed = (await res.json()) as { token?: unknown; expires_at?: unknown; repositories?: { full_name?: unknown }[] };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
    if (typeof parsed.token !== "string" || !parsed.token || typeof parsed.expires_at !== "string") {
      return { ok: false, reason: "unavailable" };
    }
    const expiresAtMs = Date.parse(parsed.expires_at);
    if (!Number.isFinite(expiresAtMs)) return { ok: false, reason: "unavailable" };
    // An omitted `repositories` array is how an all-repositories token shows up. Keep a scoped
    // token only when it is exactly this owner and repo, checking the installation list if
    // GitHub left the array off the token response.
    if (repository) {
      const listed = Array.isArray(parsed.repositories) ? parsed.repositories : undefined;
      const covers = listed
        ? exactlyThisRepo(listed, repository.owner, repository.name)
        : await this.tokenCovers(parsed.token, repository.owner, repository.name);
      if (covers !== true) return { ok: false, reason: covers === "unavailable" ? "unavailable" : "not-installed" };
    }
    this.tokens.set(key, { token: parsed.token, expiresAtMs });
    return { ok: true, token: parsed.token };
  }

  private async tokenCovers(token: string, owner: string, repo: string): Promise<boolean | "unavailable"> {
    const res = await this.call("https://api.github.com/installation/repositories?per_page=100", token);
    if (!res?.ok) return "unavailable";
    let body: { repositories?: { full_name?: unknown }[] };
    try {
      body = (await res.json()) as { repositories?: { full_name?: unknown }[] };
    } catch {
      return "unavailable";
    }
    return exactlyThisRepo(body.repositories, owner, repo);
  }

  private async call(url: string, token: string, init?: { method?: string; body?: string }): Promise<Response | undefined> {
    try {
      return await this.fetchImpl(url, {
        method: init?.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "outfitter-api",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
        },
        body: init?.body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      console.warn(`[github-catalog] ${init?.method ?? "GET"} failed: ${errorName(err)}`);
      return undefined;
    }
  }
}
