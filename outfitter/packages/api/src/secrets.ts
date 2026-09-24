// SecretsBroker: hands a run its per-session GitHub token and LiteLLM key. Per EPIC.md's "no
// shared secrets between our components" decision, these are only ever sent to agentd over the
// authenticated WebSocket inside run.spec, never as job/container env.

import type { Session, Guru } from "./store/types.ts";
import { GithubAppTokens, type InstallationToken } from "./github-app.ts";

export interface RunSecrets {
  githubToken: string;
  litellmKey: string;
  /** Set when `githubToken` is a GitHub App installation token, so the run can be refreshed. */
  githubTokenExpiresAt?: string;
}

export interface SecretsBroker {
  secretsForRun(session: Session, guru: Guru): Promise<RunSecrets>;
  /** A fresh installation token for a run that is already using the App. Undefined when the App is not configured or GitHub refused the mint. */
  refreshGithubAppToken?(session: Session): Promise<InstallationToken | undefined>;
  /** A LiteLLM key usable for calls with no specific run/guru behind them, e.g. the E2.10 provider
   * status service's LiteLLM probe when config.litellmAdminKey isn't set. Falls back to the same
   * default key a guru with no key of its own would get. */
  defaultLitellmKey(): Promise<string>;
}

/** Dev broker: reads fixed values from env so local runs work with no Secret Manager. Defaults to
 * an empty githubToken: dev mode means "no secrets available", so agentlink.ts's buildRunSpec
 * skips the missing-token check entirely when config.devMode is true, and a repo session clones
 * anonymously instead. A non-empty placeholder here would otherwise be sent to git as a real
 * credential and turn an anonymous public clone into a 401 (see agentlink.ts). Set
 * OUTFITTER_DEV_GITHUB_TOKEN when a dev/test repo session actually needs to clone a private repo. */
export class MemorySecretsBroker implements SecretsBroker {
  private readonly githubToken: string;
  private readonly litellmKey: string;

  constructor(
    githubToken = process.env.OUTFITTER_DEV_GITHUB_TOKEN ?? "",
    litellmKey = process.env.OUTFITTER_DEV_LITELLM_KEY ?? "",
  ) {
    this.githubToken = githubToken;
    this.litellmKey = litellmKey;
  }

  async secretsForRun(): Promise<RunSecrets> {
    return { githubToken: this.githubToken, litellmKey: this.litellmKey };
  }

  async defaultLitellmKey(): Promise<string> {
    return this.litellmKey;
  }
}

/** The shared GitHub token any repo session falls back to when it has no
 * `outfitter-github-token-<sessionId>` secret of its own, mirroring `outfitter-litellm-key-default`
 * for guru LiteLLM keys. Deliberately org-wide and therefore looser than a per-session PAT, which
 * is why only a session with a repo falls back to it: see `githubTokenForSession` and
 * deploy/README.md (b). */
export const GITHUB_TOKEN_DEFAULT_SECRET = "outfitter-github-token-default";

/**
 * Production broker: reads Secret Manager over ADC via the Secret Manager REST API (no
 * @google-cloud/secret-manager dependency needed for one call). The shape of the secret names is
 * a placeholder until phase 2's per-session GitHub App tokens land (EPIC.md E2.5); see
 * deploy/README.md for the full naming scheme.
 *
 * A missing secret is not itself an error here: `outfitter-github-token-<sessionId>` legitimately
 * doesn't exist for a repo-less session (and may not exist yet for a fresh repo session either),
 * and both per-id secrets fall back to a shared default — `outfitter-litellm-key-default` and
 * `outfitter-github-token-default` — before giving up. Callers decide whether an empty value is
 * fatal — agentlink.ts's buildRunSpec does, for githubToken on a session that actually has a repo.
 * accessSecretOrEmpty resolves any other error (auth failure, network, malformed payload) by
 * rethrowing, since those aren't a "the secret doesn't exist" signal.
 */
export class GcpSecretsBroker implements SecretsBroker {
  private readonly project: string;
  private readonly fetchSecret: (secretId: string) => Promise<string>;
  private readonly app: GithubAppTokens;
  /** Lazily built on first access and reused after that, instead of a fresh GoogleAuth client (and
   * its own ADC lookup) per secret fetch. */
  private authClientPromise: ReturnType<GcpSecretsBroker["buildAuthClient"]> | undefined;

  /** `fetchSecret` is injectable so tests can stub Secret Manager access without touching ADC or
   * the network; production code (main.ts) always omits it and gets accessSecretFromGcp. */
  constructor(project: string, fetchSecret?: (secretId: string) => Promise<string>, app?: GithubAppTokens) {
    this.project = project;
    this.fetchSecret = fetchSecret ?? ((secretId) => this.accessSecretFromGcp(secretId));
    this.app = app ?? new GithubAppTokens(async (secretId) => {
      try {
        return (await this.fetchSecret(secretId)).trim();
      } catch (err) {
        if (isSecretNotFoundError(err)) return "";
        throw err;
      }
    });
  }

  async secretsForRun(session: Session, guru: Guru): Promise<RunSecrets> {
    const [github, litellmKey] = await Promise.all([
      this.githubTokenForSession(session),
      this.litellmKeyForGuru(guru.id),
    ]);
    return { githubToken: github.token, litellmKey, ...(github.expiresAt ? { githubTokenExpiresAt: github.expiresAt } : {}) };
  }

  async refreshGithubAppToken(session: Session): Promise<InstallationToken | undefined> {
    if (!session.repo) return undefined;
    return this.app.mint(session.repo);
  }

  /** The session's own token if it has one, else — for a session that actually has a repo — the
   * shared `outfitter-github-token-default`.
   *
   * The per-session secret stays the preferred form: a fine-grained PAT scoped to that one repo is
   * a far smaller blast radius than one token every repo session can reach. But requiring it meant
   * an operator had to mint a PAT by hand, against a session id that only exists once the session
   * has been created, before that session's first run could get past buildRunSpec's fatal check —
   * which is what the shared fallback exists to avoid.
   *
   * The fallback is deliberately gated on `session.repo`. run.spec carries `secrets` for every
   * run, repo or not (agentlink.ts), so falling back unconditionally would hand the org-wide token
   * to sandboxes that provably have nothing to clone or push — strictly more exposure for no
   * capability. A repo-less session with a token of its own still gets it, since creating that
   * secret is a deliberate act; it just isn't given one it was never granted. Logs which of the
   * two a run ended up with, because "the token worked" and "the token I expected" are different
   * questions once something fails to clone or push. */
  private async githubTokenForSession(session: Session): Promise<{ token: string; expiresAt?: string }> {
    const perSession = `outfitter-github-token-${session.id}`;
    const own = await this.accessSecretOrEmpty(perSession);
    if (own) {
      console.log(`[secrets] session ${session.id}: using ${perSession}`);
      return { token: own };
    }
    if (!session.repo) return { token: "" };
    const minted = await this.app.mint(session.repo);
    if (minted) {
      console.log(`[secrets] session ${session.id}: using a GitHub App installation token`);
      return { token: minted.token, expiresAt: minted.expiresAt };
    }
    const shared = await this.accessSecretOrEmpty(GITHUB_TOKEN_DEFAULT_SECRET);
    if (shared) {
      console.log(
        `[secrets] session ${session.id}: ${perSession} not set; using ${GITHUB_TOKEN_DEFAULT_SECRET}`,
      );
    }
    return { token: shared };
  }

  private async litellmKeyForGuru(guruId: string): Promise<string> {
    const key = await this.accessSecretOrEmpty(`outfitter-litellm-key-${guruId}`);
    if (key) return key;
    return this.defaultLitellmKey();
  }

  async defaultLitellmKey(): Promise<string> {
    return this.accessSecretOrEmpty("outfitter-litellm-key-default");
  }

  private async accessSecretOrEmpty(secretId: string): Promise<string> {
    try {
      return await this.fetchSecret(secretId);
    } catch (err) {
      if (!isSecretNotFoundError(err)) throw err;
      console.warn(`[secrets] ${secretId} not found in Secret Manager; resolving to ""`);
      return "";
    }
  }

  private async accessSecretFromGcp(secretId: string): Promise<string> {
    const client = await this.getAuthClient();
    const url = `https://secretmanager.googleapis.com/v1/projects/${this.project}/secrets/${secretId}/versions/latest:access`;
    const res = await client.request<{ payload: { data: string } }>({ url });
    const base64 = res.data.payload.data;
    return Buffer.from(base64, "base64").toString("utf8");
  }

  /** Builds the ADC client once (lazily, on first secret access) and reuses it for every
   * subsequent fetch, instead of a fresh `GoogleAuth` instance (and its own ADC lookup) per call. */
  private getAuthClient() {
    if (!this.authClientPromise) this.authClientPromise = this.buildAuthClient();
    return this.authClientPromise;
  }

  private async buildAuthClient() {
    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    return auth.getClient();
  }
}

/** True for a Secret Manager "no such secret/version" failure: a Gaxios HTTP 404, or (in case a
 * client surfaces it as a raw gRPC status instead) code 5 NOT_FOUND. Any other shape of error
 * (network, auth, 403) is treated as real and rethrown by the caller. */
function isSecretNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { response?: { status?: number }; code?: number | string; status?: number };
  const status = e.response?.status ?? e.code ?? e.status;
  return status === 404 || status === "404" || status === 5;
}

// ---------- SecretAdmin (operator settings: routes/operator.ts) ----------
//
// A second, smaller interface alongside SecretsBroker: that one hands a *run* the one secret it
// needs (read-only, scoped to a session/guru); this one is what the operator settings page uses to
// see and change the managed secrets themselves (list state, add a version, disable all enabled
// versions, read a value back for masking/testing). Kept separate rather than folded into
// SecretsBroker because the two have very different callers (agentlink.ts's run startup vs. an
// operator-only route) and different trust levels (broker: any run; admin: requireOperator only).

/** What GET /api/operator/settings shows for one managed secret's current state. Never the full
 * value -- `masked` is the value's last 4 characters (only when the value is over 12 characters
 * long, per the operators.md design), everything else is metadata. */
export interface SecretVersionInfo {
  set: boolean;
  masked?: string;
  /** Create time of the latest enabled version, if Secret Manager reports one. */
  updatedAt?: string;
}

export interface SecretAdmin {
  info(secretName: string): Promise<SecretVersionInfo>;
  /** Adds a new enabled version, creating the secret (automatic replication) first if it doesn't
   * exist yet. `value` is the caller's responsibility to validate/trim -- this just stores it. */
  addVersion(secretName: string, value: string): Promise<void>;
  /** Disables every currently-enabled version (does not destroy anything, so it's recoverable from
   * the console). A no-op if the secret doesn't exist or has no enabled versions. */
  disableAllEnabled(secretName: string): Promise<void>;
  /** The latest enabled version's plaintext, or undefined if the secret doesn't exist / has no
   * enabled version. Used for masking and as the "test the stored value" fallback when
   * POST /api/operator/secrets/:name/test is called with no explicit value. */
  accessLatest(secretName: string): Promise<string | undefined>;
}

/** Only the last 4 characters, and only past a length where a partial reveal isn't itself most of
 * the secret (operators.md's design choice, mirrored from mgm-admin's Connections page). */
function maskTail(value: string): string | undefined {
  return value.length > 12 ? `…${value.slice(-4)}` : undefined;
}

/** Secret Manager REST version resource names end in `.../versions/<N>`; N is what every
 * version-scoped call (access/disable) needs. */
function versionNumber(name: string): number {
  const match = /\/versions\/(\d+)$/.exec(name);
  return match ? Number.parseInt(match[1], 10) : 0;
}

interface SecretManagerVersion {
  name: string;
  state: string;
  createTime?: string;
}

/** Production SecretAdmin: Secret Manager over ADC via the REST API, same approach as
 * GcpSecretsBroker above (no @google-cloud/secret-manager dependency needed). */
export class GcpSecretAdmin implements SecretAdmin {
  private readonly project: string;
  private authClientPromise: ReturnType<GcpSecretAdmin["buildAuthClient"]> | undefined;

  constructor(project: string) {
    this.project = project;
  }

  async info(secretName: string): Promise<SecretVersionInfo> {
    const versions = await this.listEnabledVersionsDesc(secretName);
    const latest = versions[0];
    if (!latest) return { set: false };
    const value = await this.accessVersion(secretName, versionNumber(latest.name));
    return { set: true, masked: maskTail(value), updatedAt: latest.createTime };
  }

  async addVersion(secretName: string, value: string): Promise<void> {
    const client = await this.getAuthClient();
    await this.ensureSecretExists(client, secretName);
    await client.request({
      url: `${this.secretUrl(secretName)}:addVersion`,
      method: "POST",
      data: { payload: { data: Buffer.from(value, "utf8").toString("base64") } },
    });
  }

  async disableAllEnabled(secretName: string): Promise<void> {
    const client = await this.getAuthClient();
    const versions = await this.listEnabledVersionsDesc(secretName);
    for (const version of versions) {
      await client.request({
        url: `${this.secretUrl(secretName)}/versions/${versionNumber(version.name)}:disable`,
        method: "POST",
      });
    }
  }

  async accessLatest(secretName: string): Promise<string | undefined> {
    const versions = await this.listEnabledVersionsDesc(secretName);
    const latest = versions[0];
    if (!latest) return undefined;
    return this.accessVersion(secretName, versionNumber(latest.name));
  }

  private secretUrl(secretName: string): string {
    return `https://secretmanager.googleapis.com/v1/projects/${this.project}/secrets/${secretName}`;
  }

  /** Enabled versions, newest first. Empty (not thrown) when the secret doesn't exist at all. */
  private async listEnabledVersionsDesc(secretName: string): Promise<SecretManagerVersion[]> {
    const client = await this.getAuthClient();
    try {
      const res = await client.request<{ versions?: SecretManagerVersion[] }>({
        url: `${this.secretUrl(secretName)}/versions`,
      });
      return (res.data.versions ?? [])
        .filter((v) => v.state === "ENABLED")
        .sort((a, b) => versionNumber(b.name) - versionNumber(a.name));
    } catch (err) {
      if (isSecretNotFoundError(err)) return [];
      throw err;
    }
  }

  private async accessVersion(secretName: string, version: number): Promise<string> {
    const client = await this.getAuthClient();
    const res = await client.request<{ payload: { data: string } }>({
      url: `${this.secretUrl(secretName)}/versions/${version}:access`,
    });
    return Buffer.from(res.data.payload.data, "base64").toString("utf8");
  }

  private async ensureSecretExists(client: Awaited<ReturnType<GcpSecretAdmin["buildAuthClient"]>>, secretName: string): Promise<void> {
    try {
      await client.request({ url: this.secretUrl(secretName) });
      return; // already exists
    } catch (err) {
      if (!isSecretNotFoundError(err)) throw err;
    }
    await client.request({
      url: `https://secretmanager.googleapis.com/v1/projects/${this.project}/secrets`,
      method: "POST",
      params: { secretId: secretName },
      data: { replication: { automatic: {} } },
    });
  }

  private getAuthClient() {
    if (!this.authClientPromise) this.authClientPromise = this.buildAuthClient();
    return this.authClientPromise;
  }

  private async buildAuthClient() {
    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
    return auth.getClient();
  }
}

interface MemorySecretVersion {
  value: string;
  enabled: boolean;
  createdAt: string;
}

/** Dev/test SecretAdmin: an in-memory map, so operator-settings tests never touch GCP. Versions
 * are appended in order (last = newest), mirroring Secret Manager's own numbering. */
export class MemorySecretAdmin implements SecretAdmin {
  private readonly secrets = new Map<string, MemorySecretVersion[]>();

  async info(secretName: string): Promise<SecretVersionInfo> {
    const latest = this.latestEnabled(secretName);
    if (!latest) return { set: false };
    return { set: true, masked: maskTail(latest.value), updatedAt: latest.createdAt };
  }

  async addVersion(secretName: string, value: string): Promise<void> {
    const versions = this.secrets.get(secretName) ?? [];
    versions.push({ value, enabled: true, createdAt: new Date().toISOString() });
    this.secrets.set(secretName, versions);
  }

  async disableAllEnabled(secretName: string): Promise<void> {
    for (const version of this.secrets.get(secretName) ?? []) version.enabled = false;
  }

  async accessLatest(secretName: string): Promise<string | undefined> {
    return this.latestEnabled(secretName)?.value;
  }

  private latestEnabled(secretName: string): MemorySecretVersion | undefined {
    const versions = this.secrets.get(secretName) ?? [];
    for (let i = versions.length - 1; i >= 0; i--) {
      if (versions[i].enabled) return versions[i];
    }
    return undefined;
  }
}
