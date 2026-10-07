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
/** How long a usable App-secret triple may skip Secret Manager. Not an installation token. */
const APP_SECRET_TTL_MS = 60_000;

/** The Drive's token (#160), sent to agentd for git over smart HTTP (clone, fetch, push through
 * the git proxy). Nothing else in the sandbox uses it: pull requests, issues and checks go through
 * the api's broker with its own token. A proxy bug must not also expose issues and PRs. Every
 * permission here is required: a Drive can't clone or push without them. */
export const DRIVE_PERMISSIONS = { contents: "write", metadata: "read" } as const;

/** What the broker can't work without: pushes (contents), opens and updates the run's pull request
 * (pull_requests), and every App token carries metadata. */
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

/** The broker's full set, the widest any mint asks for. A later permission on this same App (E6)
 * must not widen these tokens: a mint never asks for more than its profile's set. */
export const RUN_PERMISSIONS = { ...REQUIRED_RUN_PERMISSIONS, ...OPTIONAL_RUN_PERMISSIONS } as const;

/** The API broker's token (#160). Never sent to the sandbox. */
export const BROKER_PERMISSIONS = RUN_PERMISSIONS;

/** #500: re-running a session's failed workflow runs from the web UI. Its own profile, minted only
 * by that one route, so an installation without `actions: write` leaves the broker's and the
 * Drive's mints alone: only this mint fails (permissions-missing) until an owner grants it. */
export const RERUN_PERMISSIONS = { actions: "write", metadata: "read" } as const;

type RunPermission = keyof typeof RUN_PERMISSIONS;
type PermissionSet = Partial<Record<RunPermission, "read" | "write">>;

/** Which token a mint is for. Each has its own full set, required subset, token cache entries and
 * remembered reduced set, so they never stand in for each other. */
type TokenProfile = "drive" | "broker" | "rerun";
type InstallationPermissions = typeof DRIVE_PERMISSIONS | typeof BROKER_PERMISSIONS | typeof RERUN_PERMISSIONS;
const PROFILES: Record<TokenProfile, { all: PermissionSet; required: PermissionSet }> = {
  drive: { all: DRIVE_PERMISSIONS, required: DRIVE_PERMISSIONS },
  broker: { all: RUN_PERMISSIONS, required: REQUIRED_RUN_PERMISSIONS },
  rerun: { all: RERUN_PERMISSIONS, required: RERUN_PERMISSIONS },
};

/** Stable across key order, so two permission sets can't be taken for one another. */
function permissionKey(permissions: PermissionSet): string {
  return Object.entries(permissions)
    .map(([name, value]) => `${name}=${value}`)
    .sort()
    .join(",");
}

/** The profile a caller's permission set names. Anything but exactly the broker's or the re-run
 * set is the Drive's, the narrowest. */
function profileOf(permissions: InstallationPermissions): TokenProfile {
  const key = permissionKey(permissions);
  if (key === permissionKey(BROKER_PERMISSIONS)) return "broker";
  if (key === permissionKey(RERUN_PERMISSIONS)) return "rerun";
  return "drive";
}

/** How long the installation's account (for notes) and a reduced permission set (#172) are reused.
 * Once a reduced set expires, the next mint asks for the full set again, so an owner granting a
 * missing optional permission is picked up within about this long, without a restart; a cached
 * token minted with the reduced set is replaced on its next use after that. A failed mint always
 * reads the installation's grants fresh. */
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
 * - `permissions-missing` (#172): the installation doesn't grant a permission the token can't do
 *   without (DRIVE_PERMISSIONS for the Drive's, REQUIRED_RUN_PERMISSIONS for the broker's). `missingPermissions` names them when the installation's
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

/** The part of a profile's set (default: the broker's) an installation grants, and the names it
 * doesn't. Never widens: only names and levels from that set come back. */
export function permissionsWithin(
  granted: Record<string, unknown>,
  profile: TokenProfile = "broker",
): { grant: PermissionSet; missing: RunPermission[] } {
  const grant: PermissionSet = {};
  const missing: RunPermission[] = [];
  for (const [name, level] of Object.entries(PROFILES[profile].all) as [RunPermission, "read" | "write"][]) {
    const have = granted[name];
    if (typeof have === "string" && (LEVEL_RANK[have] ?? 0) >= LEVEL_RANK[level]) grant[name] = level;
    else missing.push(name);
  }
  return { grant, missing };
}

function isRequired(name: string, profile: TokenProfile): boolean {
  return Object.hasOwn(PROFILES[profile].required, name);
}

function describePermissions(names: readonly RunPermission[], profile: TokenProfile): string[] {
  return names.map((name) => `${name}:${PROFILES[profile].all[name] ?? RUN_PERMISSIONS[name]}`);
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
  /** What the token was minted with. A hit is only used while a new mint would ask for the same. */
  permissions: PermissionSet;
}

interface CachedAppSecrets {
  appId: string;
  privateKey: string;
  installationId: string;
  readAt: number;
}

/**
 * Mints an installation token for one repo. Never throws: a failure comes back as a `MintResult`
 * reason, so the caller can tell "the App isn't set up" (shared PAT still applies) from "the App
 * can't reach this repo" and "try again" (neither may fall back; #158).
 *
 * The default permission set is the Drive's. Pass `BROKER_PERMISSIONS` for the API process.
 * The two never share a cache entry or a remembered reduced set.
 */
export class GithubAppTokens {
  private readonly cache = new Map<string, CachedToken>();
  /** GET /app/installations/{id}, by installation id. */
  private readonly installations = new Map<string, InstallationInfo>();
  /** Lookups in flight, so concurrent failed mints share one request. */
  private readonly installationLookups = new Map<string, Promise<InstallationInfo | undefined>>();
  /** #172: the smaller permission set an installation last accepted, by `installationId:profile`,
   * so the next mint doesn't take the 422 first. Expires after INSTALLATION_INFO_TTL_MS; then the
   * profile's full set is tried again. */
  private readonly reducedPermissions = new Map<string, { permissions: PermissionSet; atMs: number }>();
  /** `installationId:profile:dropped permissions` already warned about. Cleared for that
   * installation and profile once a full-set mint succeeds, so losing a permission again warns
   * again. */
  private readonly warnedOptional = new Set<string>();
  /** Usable App id, private key, and installation id only. A throw or an empty/unusable triple is
   * not stored, so the next mint reads Secret Manager again instead of keeping a token alive. */
  private appSecrets: CachedAppSecrets | undefined;
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

  async mint(ownerRepo: string, permissions: InstallationPermissions = DRIVE_PERMISSIONS): Promise<MintResult> {
    try {
      return await this.mintOnce(ownerRepo, permissions);
    } catch (err) {
      console.warn(`[github-app] installation token mint failed: ${errorName(err)}`);
      return UNAVAILABLE;
    }
  }

  private async mintOnce(ownerRepo: string, permissions: InstallationPermissions): Promise<MintResult> {
    const profile = profileOf(permissions);
    const full = PROFILES[profile].all;
    const secretHit = this.appSecrets;
    const rereadSecrets = !secretHit || this.now() - secretHit.readAt >= APP_SECRET_TTL_MS;
    let appId: string;
    let privateKey: string;
    let installationId: string;
    if (!rereadSecrets && secretHit) {
      appId = secretHit.appId;
      privateKey = secretHit.privateKey;
      installationId = secretHit.installationId;
    } else {
      try {
        [appId, privateKey, installationId] = await Promise.all([
          this.read(GITHUB_APP_ID_SECRET),
          this.read(GITHUB_APP_KEY_SECRET),
          this.read(GITHUB_APP_INSTALLATION_SECRET),
        ]);
      } catch (err) {
        // `read` resolves a missing secret to "", so this is a real failure, not "not set up".
        // A throw is not cached: the next mint has to ask Secret Manager again.
        this.appSecrets = undefined;
        console.warn(`[github-app] app secret read failed: ${errorName(err)}`);
        return UNAVAILABLE;
      }
    }
    // Before the token cache. A cached installation token must not outlive secrets that are no
    // longer usable (#158/#161). An empty or unusable triple is not cached either.
    if (!githubAppSecretsUsable(appId, privateKey, installationId)) {
      this.appSecrets = undefined;
      if (![appId, privateKey, installationId].some((value) => value.trim() !== "")) return NOT_CONFIGURED;
      console.warn("[github-app] app secrets are set but not usable (numeric app id, numeric installation id, PEM key)");
      return MISCONFIGURED;
    }
    if (rereadSecrets) this.appSecrets = { appId, privateKey, installationId, readAt: this.now() };
    // After the secrets, so a deployment with no App still treats an odd repo string as before.
    const parsed = sessionGithubRepo(ownerRepo);
    if (!parsed) return NOT_INSTALLED;
    const { owner, repo } = parsed;
    appId = appId.trim();
    installationId = installationId.trim();
    const key = `${installationId}:${owner.toLowerCase()}/${repo.toLowerCase()}:${profile}`;
    const reduced = this.reducedPermissions.get(`${installationId}:${profile}`);
    let requested: PermissionSet =
      reduced && this.now() - reduced.atMs < INSTALLATION_INFO_TTL_MS ? reduced.permissions : { ...full };
    const hit = this.cache.get(key);
    // A token minted with a reduced set is not reused once a mint would ask for more (#172).
    if (hit && hit.expiresAtMs - this.now() > REFRESH_EARLY_MS && samePermissions(hit.permissions, requested)) {
      return { ok: true, token: hit.token, expiresAt: hit.expiresAt };
    }
    let jwt: string;
    try {
      jwt = githubAppJwt(appId, privateKey, Math.floor(this.now() / 1000));
    } catch (err) {
      // The secrets look usable but the key won't sign. Not a reason to hand out the shared PAT.
      console.warn(`[github-app] could not sign the app jwt: ${errorName(err)}`);
      return UNAVAILABLE;
    }
    let res = await this.requestToken(installationId, jwt, repo, requested);
    if (!res) return UNAVAILABLE;
    if (res.status === 422) {
      const message = await githubMessage(res);
      const kind = classifyTokenRequest422(message);
      console.warn(`[github-app] installation token request returned 422 (${kind}): ${message ?? "no message"}`);
      if (kind === "repository") return this.notInstalled(installationId, jwt);
      // #172: the failure path, so read the installation's grants fresh: cached ones could be from
      // before an owner changed them, and would make the retry repeat the request just refused.
      const info = await this.installationInfo(installationId, jwt, true);
      const within = info?.permissions ? permissionsWithin(info.permissions, profile) : undefined;
      if (kind === "other") {
        // Wording GitHub may change: still a permissions problem if the grants lack something we
        // asked for. Otherwise nothing smaller would help.
        const lacking = within ? (Object.keys(requested) as RunPermission[]).filter((name) => !(name in within.grant)) : [];
        if (lacking.length === 0) return { ok: false, reason: "rejected", ...(message ? { githubMessage: message } : {}) };
        console.warn(`[github-app] treating that 422 as a permissions one: the installation doesn't grant ${describePermissions(lacking, profile).join(", ")}`);
      }
      // An optional permission the installation doesn't grant must not stop the run. Ask again for
      // only what it grants (never more than the profile's set), or for just the required set when
      // the grants can't be read. The Drive's set has nothing optional.
      const missingRequired = within ? within.missing.filter((name) => isRequired(name, profile)) : [];
      if (missingRequired.length > 0) {
        const missing = describePermissions(missingRequired, profile);
        console.warn(`[github-app] installation ${installationId} lacks required permissions: ${missing.join(", ")}`);
        return { ok: false, reason: "permissions-missing", missingPermissions: missing, ...accountOf(info) };
      }
      const retry: PermissionSet = within ? within.grant : { ...PROFILES[profile].required };
      // Already asked for exactly this and GitHub said no: nothing smaller would still work.
      if (samePermissions(retry, requested)) return { ok: false, reason: "permissions-missing", ...accountOf(info) };
      requested = retry;
      res = await this.requestToken(installationId, jwt, repo, requested);
      if (!res) return UNAVAILABLE;
      if (res.status === 422) {
        const again = await githubMessage(res);
        const againKind = classifyTokenRequest422(again);
        console.warn(`[github-app] installation token request (reduced permissions) returned 422 (${againKind}): ${again ?? "no message"}`);
        if (againKind === "repository") return this.notInstalled(installationId, jwt);
        if (againKind === "other") return { ok: false, reason: "rejected", ...(again ? { githubMessage: again } : {}) };
        return { ok: false, reason: "permissions-missing", ...accountOf(info) };
      }
    }
    if (!res.ok) {
      console.warn(`[github-app] installation token request returned ${res.status}`);
      // 404: no such installation (the App was uninstalled from the account). Anything else may pass.
      return res.status === 404 ? NOT_INSTALLED : UNAVAILABLE;
    }
    this.notePermissions(installationId, profile, requested);
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
    this.cache.set(key, { token: body.token, expiresAtMs, expiresAt: body.expires_at, permissions: requested });
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

  /** #172: a token request with `requested` succeeded. The profile's full set clears any reduced
   * one (and its warning); a reduced set is remembered and warned about once. */
  private notePermissions(installationId: string, profile: TokenProfile, requested: PermissionSet): void {
    const scope = `${installationId}:${profile}`;
    const dropped = (Object.keys(PROFILES[profile].all) as RunPermission[]).filter((name) => !(name in requested));
    if (dropped.length === 0) {
      this.reducedPermissions.delete(scope);
      for (const warned of this.warnedOptional) if (warned.startsWith(`${scope}:`)) this.warnedOptional.delete(warned);
      return;
    }
    this.reducedPermissions.set(scope, { permissions: requested, atMs: this.now() });
    const warnKey = `${scope}:${dropped.join(",")}`;
    if (this.warnedOptional.has(warnKey)) return;
    this.warnedOptional.add(warnKey);
    console.warn(
      `[github-app] installation ${installationId} doesn't grant ${describePermissions(dropped, profile).join(", ")}; ` +
        "minting run tokens without them (broker tools that need them answer \"not permitted\")",
    );
  }

  private async notInstalled(installationId: string, jwt: string): Promise<MintResult> {
    return { ...NOT_INSTALLED, ...accountOf(await this.installationInfo(installationId, jwt)) };
  }

  /** GET /app/installations/{id}: the account it's on and the permissions it grants. Cached for
   * INSTALLATION_INFO_TTL_MS unless `fresh`; concurrent callers share one request. Undefined, and
   * not cached, when GitHub doesn't answer usefully. */
  private async installationInfo(installationId: string, jwt: string, fresh = false): Promise<InstallationInfo | undefined> {
    const hit = this.installations.get(installationId);
    if (!fresh && hit && this.now() - hit.fetchedAtMs < INSTALLATION_INFO_TTL_MS) return hit;
    const inFlight = this.installationLookups.get(installationId);
    if (inFlight) return inFlight;
    const lookup = this.fetchInstallationInfo(installationId, jwt).finally(() => this.installationLookups.delete(installationId));
    this.installationLookups.set(installationId, lookup);
    return lookup;
  }

  private async fetchInstallationInfo(installationId: string, jwt: string): Promise<InstallationInfo | undefined> {
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
