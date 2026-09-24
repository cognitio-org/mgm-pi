// GitHub App installation tokens (issue #93). The private key never leaves this process.
// A per-session PAT still wins over a minted token; see secrets.ts.

import { createSign } from "node:crypto";

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
export function refreshDelayMs(expiresAt: string, now: number): number | undefined {
  const exp = Date.parse(expiresAt);
  if (!Number.isFinite(exp)) return undefined;
  return Math.max(MIN_REFRESH_DELAY_MS, exp - now - REFRESH_EARLY_MS);
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

/** `owner/repo` → the repo name GitHub's installation-token `repositories` field wants. */
export function githubRepoName(ownerRepo: string): string | undefined {
  const parts = ownerRepo.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  if (!/^[A-Za-z0-9_.-]+$/.test(parts[1])) return undefined;
  return parts[1];
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
    const repo = githubRepoName(ownerRepo);
    if (!repo) return undefined;
    const [appId, privateKey, installationId] = await Promise.all([
      this.read(GITHUB_APP_ID_SECRET),
      this.read(GITHUB_APP_KEY_SECRET),
      this.read(GITHUB_APP_INSTALLATION_SECRET),
    ]);
    if (!/^\d+$/.test(appId) || !/^\d+$/.test(installationId) || !privateKey.includes("PRIVATE KEY")) return undefined;
    const key = `${installationId}:${repo}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAtMs - this.now() > REFRESH_EARLY_MS) return { token: hit.token, expiresAt: hit.expiresAt };
    const jwt = githubAppJwt(appId, privateKey, Math.floor(this.now() / 1000));
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
      console.warn(`[github-app] installation token request failed: ${err instanceof Error ? err.name : "Error"}`);
      return undefined;
    }
    if (!res.ok) {
      console.warn(`[github-app] installation token request returned ${res.status}`);
      return undefined;
    }
    const body = (await res.json()) as { token?: unknown; expires_at?: unknown };
    if (typeof body.token !== "string" || !body.token || typeof body.expires_at !== "string") return undefined;
    const expiresAtMs = Date.parse(body.expires_at);
    if (!Number.isFinite(expiresAtMs)) return undefined;
    this.cache.set(key, { token: body.token, expiresAtMs, expiresAt: body.expires_at });
    return { token: body.token, expiresAt: body.expires_at };
  }
}
