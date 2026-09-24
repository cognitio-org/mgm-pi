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

export interface InstallationToken {
  token: string;
  expiresAt: string;
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

/** Repo name for the installation-token `repositories` field. Same stored forms as `parseSessionRepo`. */
export function githubRepoName(sessionRepo: string): string | undefined {
  const parsed = parseSessionRepo(sessionRepo);
  if (!parsed || !/^[A-Za-z0-9_.-]+$/.test(parsed.repo)) return undefined;
  return parsed.repo;
}

/** True when the three App secrets are values `mint` will actually try to sign with. */
export function githubAppSecretsUsable(appId: string, privateKey: string, installationId: string): boolean {
  return /^\d+$/.test(appId.trim()) && /^\d+$/.test(installationId.trim()) && privateKey.includes("PRIVATE KEY");
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "Error";
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
  expiresAt: string;
}

/**
 * Mints an installation token for one repo. Missing or unusable App secrets, and a GitHub
 * error, return undefined so the caller can fall back to the shared PAT.
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

  async mint(ownerRepo: string): Promise<InstallationToken | undefined> {
    try {
      return await this.mintOnce(ownerRepo);
    } catch (err) {
      console.warn(`[github-app] installation token mint failed: ${errorName(err)}`);
      return undefined;
    }
  }

  private async mintOnce(ownerRepo: string): Promise<InstallationToken | undefined> {
    const repo = githubRepoName(ownerRepo);
    if (!repo) return undefined;
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
      console.warn(`[github-app] app secret read failed: ${errorName(err)}`);
      return undefined;
    }
    if (!githubAppSecretsUsable(appId, privateKey, installationId)) return undefined;
    appId = appId.trim();
    installationId = installationId.trim();
    const key = `${installationId}:${repo}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAtMs - this.now() > REFRESH_EARLY_MS) return { token: hit.token, expiresAt: hit.expiresAt };
    let jwt: string;
    try {
      jwt = githubAppJwt(appId, privateKey, Math.floor(this.now() / 1000));
    } catch (err) {
      console.warn(`[github-app] could not sign the app jwt: ${errorName(err)}`);
      return undefined;
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
        body: JSON.stringify({ repositories: [repo] }),
      });
    } catch (err) {
      console.warn(`[github-app] installation token request failed: ${errorName(err)}`);
      return undefined;
    }
    if (!res.ok) {
      console.warn(`[github-app] installation token request returned ${res.status}`);
      return undefined;
    }
    let body: { token?: unknown; expires_at?: unknown };
    try {
      body = (await res.json()) as { token?: unknown; expires_at?: unknown };
    } catch (err) {
      console.warn(`[github-app] installation token response was not json: ${errorName(err)}`);
      return undefined;
    }
    if (typeof body.token !== "string" || !body.token || typeof body.expires_at !== "string") return undefined;
    const expiresAtMs = Date.parse(body.expires_at);
    if (!Number.isFinite(expiresAtMs)) return undefined;
    this.cache.set(key, { token: body.token, expiresAtMs, expiresAt: body.expires_at });
    return { token: body.token, expiresAt: body.expires_at };
  }
}
