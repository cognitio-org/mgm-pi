// GitHub App installation tokens (issue #93). The private key never leaves this process.
// A per-session PAT still wins over a minted token; see secrets.ts.

import { createSign } from "node:crypto";
import { parseSessionRepo } from "./session-repo.ts";

export const GITHUB_APP_ID_SECRET = "outfitter-github-app-id";
export const GITHUB_APP_KEY_SECRET = "outfitter-github-app-private-key";
export const GITHUB_APP_INSTALLATION_SECRET = "outfitter-github-app-installation-id";
export const GITHUB_APP_SLUG_SECRET = "outfitter-github-app-slug";

const REFRESH_EARLY_MS = 5 * 60_000;
const MIN_REFRESH_DELAY_MS = 30_000;
const MINT_TIMEOUT_MS = 10_000;

/** What a run can't work without: cloud git clones and pushes (contents), opens and updates its
 * pull request (pull_requests), and every App token carries metadata. */
export const REQUIRED_RUN_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
} as const;

/** What only some broker tools use (the issue tools, a pull request's checks). An installation
 * that doesn't grant one still gets a token without it (#172); the broker call that needs it then
 * answers "not permitted". */
export const OPTIONAL_RUN_PERMISSIONS = {
  issues: "write",
  checks: "read",
  actions: "read",
} as const;

/** The run token asks only for what cloud git and the broker use. A later permission on this
 * same App (E6) must not widen every sandbox token: a mint never asks for more than this. */
export const RUN_PERMISSIONS = { ...REQUIRED_RUN_PERMISSIONS, ...OPTIONAL_RUN_PERMISSIONS } as const;

type RunPermission = keyof typeof RUN_PERMISSIONS;
type PermissionSet = Partial<Record<RunPermission, "read" | "write">>;

/** How long what GitHub says about the installation (its account, its granted permissions) is
 * reused. Short, so an owner accepting new permissions is picked up without a restart. */
const INSTALLATION_INFO_TTL_MS = 10 * 60_000;

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

/** Why no installation token came back (#158). Callers treat each differently:
 * - `not-configured`: none of the three App secrets is set. The App isn't in use, so the shared
 *   PAT still applies.
 * - `misconfigured`: some App secret is set but the three aren't usable (a Client ID pasted as
 *   the App id, a wrapped key, a missing installation id mid-reinstall). An operator has to fix
 *   them; no fallback, since that would quietly put every run back on the shared PAT.
 * - `not-installed`: GitHub says the App can't reach this repo (or the name isn't one it could).
 *   No fallback. `installationAccount`, when GitHub told us, lets the run's note say whether the
 *   repo is outside the installation's account altogether.
 * - `permissions-missing` (#172): the installation doesn't grant a permission the run can't do
 *   without (REQUIRED_RUN_PERMISSIONS). `missingPermissions` names them when the installation's
 *   grants could be read. A missing optional permission is not a failure: the token is minted
 *   without it.
 * - `rejected` (#172): GitHub refused the token request (422) for some other reason.
 *   `githubMessage` is GitHub's own message, which is never secret.
 * - `unavailable`: anything transient or unexpected (a network error, a timeout, a 5xx, a Secret
 *   Manager blip, a key that won't sign). No fallback; try again later.
 *
 * Everything but `unavailable` (and `not-configured`) is permanent: retrying gets the same answer
 * until someone changes the App, its installation, or the session's credentials. */
export type MintFailure =
  | "not-configured"
  | "misconfigured"
  | "not-installed"
  | "permissions-missing"
  | "rejected"
  | "unavailable";

/** What a failed mint knows beyond its reason, for the run's note. All optional. */
export interface MintFailureContext {
  /** The installation's account login (the org or user the App is installed on). */
  installationAccount?: string;
  /** Required permissions the installation doesn't grant, as `name:level`. */
  missingPermissions?: string[];
  /** GitHub's `message` for a `rejected` request. */
  githubMessage?: string;
}

export type MintResult = ({ ok: true } & InstallationToken) | ({ ok: false; reason: MintFailure } & MintFailureContext);

/** True for a failure no amount of retrying fixes without someone changing the App, its
 * installation, or the session's credentials (#172). */
export function isPermanentMintFailure(reason: MintFailure): boolean {
  return reason === "misconfigured" || reason === "not-installed" || reason === "permissions-missing" || reason === "rejected";
}

/** Which kind of 422 GitHub gave for an installation-token request, from its `message`. */
export function classifyTokenRequest422(message: string | undefined): "permissions" | "repository" | "other" {
  const text = (message ?? "").toLowerCase();
  // "The permissions requested are not granted to this installation."
  if (/permission/.test(text) && /not granted|not been granted/.test(text)) return "permissions";
  // "There is at least one repository that does not exist or is not accessible to the parent installation."
  if (/repositor/.test(text) && /not exist|not accessible|not found/.test(text)) return "repository";
  return "other";
}

const LEVEL_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** The part of RUN_PERMISSIONS an installation grants, and the names it doesn't. Never widens:
 * only names and levels from RUN_PERMISSIONS come back. */
export function permissionsWithin(granted: Record<string, unknown>): { grant: PermissionSet; missing: RunPermission[] } {
  const grant: PermissionSet = {};
  const missing: RunPermission[] = [];
  for (const [name, level] of Object.entries(RUN_PERMISSIONS) as [RunPermission, "read" | "write"][]) {
    const have = granted[name];
    if (typeof have === "string" && (LEVEL_RANK[have] ?? 0) >= LEVEL_RANK[level]) grant[name] = level;
    else missing.push(name);
  }
  return { grant, missing };
}

function isRequired(name: string): boolean {
  return Object.hasOwn(REQUIRED_RUN_PERMISSIONS, name);
}

function describePermissions(names: readonly RunPermission[]): string[] {
  return names.map((name) => `${name}:${RUN_PERMISSIONS[name]}`);
}

/** How long to wait before asking for a replacement. Undefined when `expiresAt` is not a time. */
export function refreshDelayMs(expiresAt: string, now: number, floorMs?: number): number | undefined {
  const exp = Date.parse(expiresAt);
  if (!Number.isFinite(exp)) return undefined;
  return Math.max(floorMs ?? MIN_REFRESH_DELAY_MS, exp - now - REFRESH_EARLY_MS);
}

function base64url(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data) : data;
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** RS256 JWT for `POST /app/installations/{id}/access_tokens`. `iat` is 60s behind `now`. */
export function githubAppJwt(appId: string, privateKeyPem: string, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId }));
  const data = `${header}.${payload}`;
  const sig = createSign("RSA-SHA256").update(data).sign(privateKeyPem);
  return `${data}.${base64url(sig)}`;
}

/** Owner and repo from the forms `parseSessionRepo` accepts, limited to the characters GitHub allows in those names. */
function sessionGithubRepo(sessionRepo: string): { owner: string; repo: string } | undefined {
  const parsed = parseSessionRepo(sessionRepo);
  if (!parsed) return undefined;
  if (!/^[A-Za-z0-9_.-]+$/.test(parsed.owner) || !/^[A-Za-z0-9_.-]+$/.test(parsed.repo)) return undefined;
  return parsed;
}

/** Repo name for the installation-token `repositories` field. Same stored forms as `parseSessionRepo`. */
export function githubRepoName(sessionRepo: string): string | undefined {
  return sessionGithubRepo(sessionRepo)?.repo;
}

/** True when the three App secrets are values `mint` will actually try to sign with. */
export function githubAppSecretsUsable(appId: string, privateKey: string, installationId: string): boolean {
  return /^\d+$/.test(appId.trim()) && /^\d+$/.test(installationId.trim()) && privateKey.includes("PRIVATE KEY");
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "Error";
}

const NOT_CONFIGURED: MintResult = { ok: false, reason: "not-configured" };
const MISCONFIGURED: MintResult = { ok: false, reason: "misconfigured" };
const NOT_INSTALLED: MintResult = { ok: false, reason: "not-installed" };
const UNAVAILABLE: MintResult = { ok: false, reason: "unavailable" };

interface InstallationInfo {
  account?: string;
  permissions?: Record<string, unknown>;
  fetchedAtMs: number;
}

/** GitHub's `message` from an error body, clipped. GitHub never echoes the token or the JWT. */
async function githubMessage(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { message?: unknown };
    return typeof body?.message === "string" ? body.message.slice(0, 300) : undefined;
  } catch {
    return undefined;
  }
}

function accountOf(info: InstallationInfo | undefined): { installationAccount?: string } {
  return info?.account ? { installationAccount: info.account } : {};
}

function samePermissions(a: PermissionSet, b: PermissionSet): boolean {
  const ka = Object.keys(a).sort() as RunPermission[];
  const kb = Object.keys(b).sort() as RunPermission[];
  return ka.length === kb.length && ka.every((key, i) => key === kb[i] && a[key] === b[key]);
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
  expiresAt: string;
}

/**
 * Mints an installation token for one repo. Never throws: a failure comes back as a `MintResult`
 * reason, so the caller can tell "the App isn't set up" (shared PAT still applies) from "the App
 * can't reach this repo" and "try again" (neither may fall back; #158).
 */
export class GithubAppTokens {
  private readonly cache = new Map<string, CachedToken>();
  /** GET /app/installations/{id}, by installation id. */
  private readonly installations = new Map<string, InstallationInfo>();
  /** #172: the smaller permission set an installation last accepted, so the next mint doesn't take
   * the 422 first. Expires like the installation info; then the full set is tried again. */
  private readonly reducedPermissions = new Map<string, { permissions: PermissionSet; atMs: number }>();
  /** Installations already warned about for missing optional permissions. */
  private readonly warnedOptional = new Set<string>();
  private readonly read: (secretName: string) => Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    read: (secretName: string) => Promise<string>,
    fetchImpl: typeof fetch = fetch,
    now: () => number = Date.now,
  ) {
    this.read = read;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  async mint(ownerRepo: string): Promise<MintResult> {
    try {
      return await this.mintOnce(ownerRepo);
    } catch (err) {
      console.warn(`[github-app] installation token mint failed: ${errorName(err)}`);
      return UNAVAILABLE;
    }
  }

  private async mintOnce(ownerRepo: string): Promise<MintResult> {
    let appId: string;
    let privateKey: string;
    let installationId: string;
    try {
      [appId, privateKey, installationId] = await Promise.all([
        this.read(GITHUB_APP_ID_SECRET),
        this.read(GITHUB_APP_KEY_SECRET),
        this.read(GITHUB_APP_INSTALLATION_SECRET),
      ]);
    } catch (err) {
      // `read` resolves a missing secret to "", so this is a real failure, not "not set up".
      console.warn(`[github-app] app secret read failed: ${errorName(err)}`);
      return UNAVAILABLE;
    }
    if (!githubAppSecretsUsable(appId, privateKey, installationId)) {
      if (![appId, privateKey, installationId].some((value) => value.trim() !== "")) return NOT_CONFIGURED;
      console.warn("[github-app] app secrets are set but not usable (numeric app id, numeric installation id, PEM key)");
      return MISCONFIGURED;
    }
    // After the secrets, so a deployment with no App still treats an odd repo string as before.
    const parsed = sessionGithubRepo(ownerRepo);
    if (!parsed) return NOT_INSTALLED;
    const { owner, repo } = parsed;
    appId = appId.trim();
    installationId = installationId.trim();
    const key = `${installationId}:${owner}/${repo}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAtMs - this.now() > REFRESH_EARLY_MS) return { ok: true, token: hit.token, expiresAt: hit.expiresAt };
    let jwt: string;
    try {
      jwt = githubAppJwt(appId, privateKey, Math.floor(this.now() / 1000));
    } catch (err) {
      // The secrets look usable but the key won't sign. Not a reason to hand out the shared PAT.
      console.warn(`[github-app] could not sign the app jwt: ${errorName(err)}`);
      return UNAVAILABLE;
    }
    const reduced = this.reducedPermissions.get(installationId);
    let requested: PermissionSet =
      reduced && this.now() - reduced.atMs < INSTALLATION_INFO_TTL_MS ? reduced.permissions : { ...RUN_PERMISSIONS };
    let res = await this.requestToken(installationId, jwt, repo, requested);
    if (!res) return UNAVAILABLE;
    if (res.status === 422) {
      const first = await this.classify422(res, installationId, jwt, "");
      if (first !== "permissions") return first;
      // #172: an optional permission the installation doesn't grant must not stop the run. Ask
      // again for only what it grants (never more than RUN_PERMISSIONS), or for just the required
      // set when the grants can't be read.
      const info = await this.installationInfo(installationId, jwt);
      const within = info?.permissions ? permissionsWithin(info.permissions) : undefined;
      const missingRequired = within ? within.missing.filter(isRequired) : [];
      if (missingRequired.length > 0) {
        const missing = describePermissions(missingRequired);
        console.warn(`[github-app] installation ${installationId} lacks required permissions: ${missing.join(", ")}`);
        return { ok: false, reason: "permissions-missing", missingPermissions: missing, ...accountOf(info) };
      }
      const retry: PermissionSet = within ? within.grant : { ...REQUIRED_RUN_PERMISSIONS };
      // Already asked for exactly this and GitHub said no: nothing smaller would still work.
      if (samePermissions(retry, requested)) return { ok: false, reason: "permissions-missing", ...accountOf(info) };
      requested = retry;
      res = await this.requestToken(installationId, jwt, repo, requested);
      if (!res) return UNAVAILABLE;
      if (res.status === 422) {
        const second = await this.classify422(res, installationId, jwt, " (reduced permissions)");
        if (second !== "permissions") return second;
        return { ok: false, reason: "permissions-missing", ...accountOf(info) };
      }
      if (res.ok) this.noteReducedPermissions(installationId, requested);
    }
    if (!res.ok) {
      console.warn(`[github-app] installation token request returned ${res.status}`);
      // 404: no such installation (the App was uninstalled from the account). Anything else may pass.
      return res.status === 404 ? NOT_INSTALLED : UNAVAILABLE;
    }
    let body: { token?: unknown; expires_at?: unknown; repositories?: { full_name?: unknown }[] };
    try {
      body = (await res.json()) as { token?: unknown; expires_at?: unknown; repositories?: { full_name?: unknown }[] };
    } catch (err) {
      console.warn(`[github-app] installation token response was not json: ${errorName(err)}`);
      return UNAVAILABLE;
    }
    if (typeof body.token !== "string" || !body.token || typeof body.expires_at !== "string") return UNAVAILABLE;
    const expiresAtMs = Date.parse(body.expires_at);
    if (!Number.isFinite(expiresAtMs)) return UNAVAILABLE;
    // `repositories: [name]` is resolved on the installation's account. Keep the token only when
    // GitHub says it is exactly this owner/repo. Names are case-insensitive.
    const listed = Array.isArray(body.repositories) ? body.repositories : undefined;
    const covers = listed
      ? exactlyThisRepo(listed, owner, repo)
      : await this.tokenCoversRepo(body.token, owner, repo);
    if (covers === "unavailable") return UNAVAILABLE;
    if (!covers) return this.notInstalled(installationId, jwt);
    this.cache.set(key, { token: body.token, expiresAtMs, expiresAt: body.expires_at });
    return { ok: true, token: body.token, expiresAt: body.expires_at };
  }

  /** One installation-token request. Undefined when it got no answer at all. */
  private async requestToken(installationId: string, jwt: string, repo: string, permissions: PermissionSet): Promise<Response | undefined> {
    try {
      return await this.fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "outfitter-api",
        },
        body: JSON.stringify({ repositories: [repo], permissions }),
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      });
    } catch (err) {
      console.warn(`[github-app] installation token request failed: ${errorName(err)}`);
      return undefined;
    }
  }

  /** #172: a 422 from the token request, by GitHub's message. "permissions" is left to the caller
   * (it may retry with fewer); the other two are final. Logs the classification and the message. */
  private async classify422(res: Response, installationId: string, jwt: string, label: string): Promise<MintResult | "permissions"> {
    const message = await githubMessage(res);
    const kind = classifyTokenRequest422(message);
    console.warn(`[github-app] installation token request${label} returned 422 (${kind}): ${message ?? "no message"}`);
    if (kind === "permissions") return "permissions";
    if (kind === "repository") return this.notInstalled(installationId, jwt);
    return { ok: false, reason: "rejected", ...(message ? { githubMessage: message } : {}) };
  }

  private noteReducedPermissions(installationId: string, requested: PermissionSet): void {
    this.reducedPermissions.set(installationId, { permissions: requested, atMs: this.now() });
    if (this.warnedOptional.has(installationId)) return;
    this.warnedOptional.add(installationId);
    const dropped = (Object.keys(RUN_PERMISSIONS) as RunPermission[]).filter((name) => !(name in requested));
    console.warn(
      `[github-app] installation ${installationId} doesn't grant ${describePermissions(dropped).join(", ")}; ` +
        "minting run tokens without them (broker tools that need them answer \"not permitted\")",
    );
  }

  private async notInstalled(installationId: string, jwt: string): Promise<MintResult> {
    return { ...NOT_INSTALLED, ...accountOf(await this.installationInfo(installationId, jwt)) };
  }

  /** GET /app/installations/{id}: the account it's on and the permissions it grants. Cached for
   * INSTALLATION_INFO_TTL_MS. Undefined, and not cached, when GitHub doesn't answer usefully. */
  private async installationInfo(installationId: string, jwt: string): Promise<InstallationInfo | undefined> {
    const hit = this.installations.get(installationId);
    if (hit && this.now() - hit.fetchedAtMs < INSTALLATION_INFO_TTL_MS) return hit;
    let res: Response;
    try {
      res = await this.fetchImpl(`https://api.github.com/app/installations/${installationId}`, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "outfitter-api",
        },
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      });
    } catch (err) {
      console.warn(`[github-app] installation lookup failed: ${errorName(err)}`);
      return undefined;
    }
    if (!res.ok) {
      console.warn(`[github-app] installation lookup returned ${res.status}`);
      return undefined;
    }
    let body: { account?: { login?: unknown }; permissions?: unknown };
    try {
      body = (await res.json()) as { account?: { login?: unknown }; permissions?: unknown };
    } catch {
      return undefined;
    }
    const account = typeof body?.account?.login === "string" && body.account.login ? body.account.login : undefined;
    const permissions =
      body?.permissions && typeof body.permissions === "object" && !Array.isArray(body.permissions)
        ? (body.permissions as Record<string, unknown>)
        : undefined;
    if (!account && !permissions) return undefined;
    const info: InstallationInfo = { account, permissions, fetchedAtMs: this.now() };
    this.installations.set(installationId, info);
    return info;
  }

  /** True when the token's repository list includes this owner/repo and not only a same-named
   * repo; "unavailable" when the list couldn't be read. */
  private async tokenCoversRepo(token: string, owner: string, repo: string): Promise<boolean | "unavailable"> {
    let res: Response;
    try {
      res = await this.fetchImpl("https://api.github.com/installation/repositories?per_page=100", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "outfitter-api",
        },
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      });
    } catch (err) {
      console.warn(`[github-app] repository check failed: ${errorName(err)}`);
      return "unavailable";
    }
    if (!res.ok) {
      console.warn(`[github-app] repository check returned ${res.status}`);
      return "unavailable";
    }
    let body: { repositories?: { full_name?: unknown }[] };
    try {
      body = (await res.json()) as { repositories?: { full_name?: unknown }[] };
    } catch (err) {
      console.warn(`[github-app] repository check was not json: ${errorName(err)}`);
      return "unavailable";
    }
    return exactlyThisRepo(body.repositories, owner, repo);
  }
}

/** GitHub owner and repo names are case-insensitive. One entry, this repo, nothing else. */
function exactlyThisRepo(list: { full_name?: unknown }[] | undefined, owner: string, repo: string): boolean {
  if (!list || list.length !== 1) return false;
  const name = list[0]?.full_name;
  return typeof name === "string" && name.toLowerCase() === `${owner}/${repo}`.toLowerCase();
}
