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

/** The run token asks only for what cloud git and the broker use. A later permission on this
 * same App (E6) must not widen every sandbox token. */
const RUN_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "read",
  actions: "read",
  metadata: "read",
} as const;

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

/** Why no installation token came back (#158). Callers treat each differently:
 * - `not-configured`: the App's secrets are absent or unusable. The App isn't in use, so the
 *   shared PAT still applies.
 * - `not-installed`: GitHub says the App can't reach this repo (or the name isn't one it could).
 *   No fallback; the run is told to install the App on the repo.
 * - `unavailable`: anything transient or unexpected (a network error, a timeout, a 5xx, a Secret
 *   Manager blip, a key that won't sign). No fallback; try again later. */
export type MintFailure = "not-configured" | "not-installed" | "unavailable";

export type MintResult = ({ ok: true } & InstallationToken) | { ok: false; reason: MintFailure };

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
const NOT_INSTALLED: MintResult = { ok: false, reason: "not-installed" };
const UNAVAILABLE: MintResult = { ok: false, reason: "unavailable" };

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
    const parsed = sessionGithubRepo(ownerRepo);
    if (!parsed) return NOT_INSTALLED;
    const { owner, repo } = parsed;
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
    if (!githubAppSecretsUsable(appId, privateKey, installationId)) return NOT_CONFIGURED;
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
    let res: Response;
    try {
      res = await this.fetchImpl(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "outfitter-api",
        },
        body: JSON.stringify({ repositories: [repo], permissions: RUN_PERMISSIONS }),
        signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
      });
    } catch (err) {
      console.warn(`[github-app] installation token request failed: ${errorName(err)}`);
      return UNAVAILABLE;
    }
    if (!res.ok) {
      console.warn(`[github-app] installation token request returned ${res.status}`);
      // 422: a repository in `repositories` isn't accessible to the installation. 404: no such
      // installation (the App was uninstalled from the account). Anything else may pass.
      return res.status === 422 || res.status === 404 ? NOT_INSTALLED : UNAVAILABLE;
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
    if (!covers) return NOT_INSTALLED;
    this.cache.set(key, { token: body.token, expiresAtMs, expiresAt: body.expires_at });
    return { ok: true, token: body.token, expiresAt: body.expires_at };
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
