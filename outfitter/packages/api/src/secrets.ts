// SecretsBroker: hands a run its per-session GitHub token and LiteLLM key. Per EPIC.md's "no
// shared secrets between our components" decision, these are only ever sent to agentd over the
// authenticated WebSocket inside run.spec, never as job/container env.

import type { GithubCredential, Session, Guru } from "./store/types.ts";
import {
  BROKER_PERMISSIONS,
  DRIVE_PERMISSIONS,
  GITHUB_APP_ID_SECRET,
  GITHUB_APP_INSTALLATION_SECRET,
  GITHUB_APP_KEY_SECRET,
  GITHUB_APP_SLUG_SECRET,
  GithubAppTokens,
  type MintFailure,
  type MintFailureContext,
} from "./github-app.ts";

export interface RunSecrets {
  githubToken: string;
  litellmKey: string;
  /** Which LiteLLM key `litellmKey` is: the tape's own `outfitter-litellm-key-<guruId>` ("guru"),
   * the org-wide default ("default"), or none. An A2A session runs only on "guru" (agentlink.ts):
   * a remote caller gets a bounded, revocable budget, never the org's. */
  litellmKeySource?: "guru" | "default" | "none";
  /** Set when `githubToken` is a GitHub App installation token, so the run can be refreshed. */
  githubTokenExpiresAt?: string;
  /** #158: why a repo session got no GitHub token although the App is configured. The shared PAT is
   * never used in that case: `unavailable` is worth trying again, and every other reason needs
   * someone to change the App, its installation, or the session's credentials (#172). Absent when a
   * token came back, or when nothing is configured at all. */
  githubAppFailure?: Exclude<MintFailure, "not-configured">;
  /** #172: what the failed mint knew beyond its reason (the installation's account, the missing
   * permissions, GitHub's message), for the run's note. */
  githubAppFailureContext?: MintFailureContext;
  /** Which credential `githubToken` is. `none` when the token is empty. */
  githubCredential?: GithubCredential;
}

export interface SecretsBroker {
  secretsForRun(session: Session, guru: Guru): Promise<RunSecrets>;
  /** GitHub credential for the API broker. A PAT is the same token the run gets. An App installation
   * token is minted with BROKER_PERMISSIONS and is not the drive token. */
  brokerGithubToken?(session: Session): Promise<{
    token: string;
    appFailure?: Exclude<MintFailure, "not-configured">;
  }>;
  /** The credential a live run should switch to. A per-session PAT has no `expiresAt` and replaces an installation token. Undefined when nothing is configured. `credential` is set only when a token came back. */
  refreshGithubAppToken?(session: Session): Promise<{ token: string; expiresAt?: string; credential?: Extract<GithubCredential, "app" | "session"> } | undefined>;
  /** A LiteLLM key usable for calls with no specific run/guru behind them, e.g. the E2.10 provider
   * status service's LiteLLM probe when config.litellmAdminKey isn't set. Falls back to the same
   * default key a guru with no key of its own would get. */
  defaultLitellmKey(): Promise<string>;
  /** True when the tape has a LiteLLM key of its own (`outfitter-litellm-key-<guruId>`), which an
   * A2A key's tapes need (a2a/keys.ts A2ALitellmKeyCheck). Undefined on a broker that can't tell:
   * A2A then relies on agentlink.ts's run-time refusal alone. */
  hasDedicatedLitellmKey?(guruId: string): Promise<boolean>;
}

/** E9: a session an A2A task created. Its runs never get the org-default LiteLLM key, its tape's
 * env, or a branch other than its own `outfitter/a2a-*` one. */
export function isA2ASession(session: Pick<Session, "origin" | "a2aTokenId"> | null | undefined): boolean {
  // Any non-empty origin or token id counts: an unknown origin fails closed, as A2A.
  return isSet(session?.origin) || isSet(session?.a2aTokenId);
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
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
  private readonly dedicatedGurus: ReadonlySet<string> | undefined;

  /** `dedicatedGurus`: the tapes whose key counts as their own (tests of the A2A refusal).
   * Undefined (dev): every tape's. */
  constructor(
    githubToken = process.env.OUTFITTER_DEV_GITHUB_TOKEN ?? "",
    litellmKey = process.env.OUTFITTER_DEV_LITELLM_KEY ?? "",
    dedicatedGurus?: ReadonlySet<string>,
  ) {
    this.githubToken = githubToken;
    this.litellmKey = litellmKey;
    this.dedicatedGurus = dedicatedGurus;
  }

  async secretsForRun(session?: Session, guru?: Guru): Promise<RunSecrets> {
    const dedicated = !this.dedicatedGurus || (guru !== undefined && this.dedicatedGurus.has(guru.id));
    // As GcpSecretsBroker: an A2A session never falls back to a shared key.
    const shareable = dedicated || !isA2ASession(session);
    return {
      githubToken: this.githubToken,
      litellmKey: shareable ? this.litellmKey : "",
      litellmKeySource: dedicated ? "guru" : shareable ? "default" : "none",
      githubCredential: this.githubToken ? "default" : "none",
    };
  }

  async hasDedicatedLitellmKey(guruId: string): Promise<boolean> {
    return !this.dedicatedGurus || this.dedicatedGurus.has(guruId);
  }

  async brokerGithubToken(): Promise<{ token: string }> {
    return { token: this.githubToken };
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
        if (isSecretAbsentError(err)) return "";
        // A blip reading an App secret is not "the App isn't set up": resolving it to "" would hand
        // the run the shared PAT (#158). Throw, so the mint reports `unavailable`.
        // Log the name only: Secret Manager errors can echo the request, never the key.
        console.warn(`[secrets] ${secretId} unreadable: ${err instanceof Error ? err.name : "Error"}`);
        throw err;
      }
    });
  }

  async secretsForRun(session: Session, guru: Guru): Promise<RunSecrets> {
    const [github, litellm] = await Promise.all([
      this.githubTokenForSession(session, DRIVE_PERMISSIONS),
      this.litellmKeyForGuru(guru.id, !isA2ASession(session)),
    ]);
    return {
      githubToken: github.token,
      litellmKey: litellm.key,
      litellmKeySource: litellm.source,
      ...(github.expiresAt ? { githubTokenExpiresAt: github.expiresAt } : {}),
      ...(github.appFailure ? { githubAppFailure: github.appFailure } : {}),
      ...(github.appFailureContext ? { githubAppFailureContext: github.appFailureContext } : {}),
      githubCredential: github.credential,
    };
  }

  async brokerGithubToken(session: Session): Promise<{
    token: string;
    appFailure?: Exclude<MintFailure, "not-configured">;
  }> {
    const cred = await this.githubTokenForSession(session, BROKER_PERMISSIONS);
    return cred.appFailure ? { token: cred.token, appFailure: cred.appFailure } : { token: cred.token };
  }

  async refreshGithubAppToken(session: Session): Promise<{ token: string; expiresAt?: string; credential?: "app" | "session" } | undefined> {
    const own = await this.accessSecretOrEmpty(`outfitter-github-token-${session.id}`);
    if (own) return { token: own, credential: "session" };
    if (!session.repo) return undefined;
    // A failed mint must not fall through to the shared PAT. That would replace the sandbox's
    // installation token and cancel the retry. The shared PAT is only the initial-run fallback.
    // Drive-scoped: this token is sent to agentd. No shared-PAT fallback.
    const minted = await this.app.mint(session.repo, DRIVE_PERMISSIONS);
    if (!minted.ok) return undefined;
    return { token: minted.token, expiresAt: minted.expiresAt, credential: "app" };
  }

  /** Per-session PAT, then a GitHub App installation token, then (only when the App is not
   * configured) the shared `outfitter-github-token-default`.
   *
   * The per-session secret stays the preferred form: a fine-grained PAT scoped to that one repo is
   * a far smaller blast radius than one token every repo session can reach. The App is the usual
   * cloud identity once its id, private key, and installation id are set. The shared PAT remains
   * for a deployment without the App: requiring a per-session PAT meant an operator had to mint one
   * by hand, against a session id that only exists once the session has been created, before the
   * first run could get past buildRunSpec.
   *
   * Once the App is configured, the shared PAT is never used (#158). A repo the App can't reach
   * comes back empty with `appFailure: "not-installed"`, and a failed mint with `"unavailable"`;
   * the caller decides what each means. Before, both quietly handed the run the org-wide PAT, and
   * a reconnect kept it for the rest of the run.
   *
   * The App and the shared PAT are gated on `session.repo`. run.spec carries `secrets` for every
   * run, repo or not (agentlink.ts), so handing either credential to a sandbox with nothing to
   * clone or push would be strictly more exposure for no capability. A repo-less session stops
   * before the App for that reason. One with a token of its own still gets it, since creating
   * that secret is a deliberate act. Logs which of the three a run ended up with, because "the
   * token worked" and "the token I expected" are different questions once something fails to
   * clone or push.
   *
   * `permissions` is `DRIVE_PERMISSIONS` for the token sent to agentd and `BROKER_PERMISSIONS`
   * for the API process. A PAT is the same string either way; only an installation token splits. */
  private async githubTokenForSession(
    session: Session,
    permissions: typeof DRIVE_PERMISSIONS | typeof BROKER_PERMISSIONS,
  ): Promise<{
    token: string;
    expiresAt?: string;
    appFailure?: Exclude<MintFailure, "not-configured">;
    appFailureContext?: MintFailureContext;
    credential: GithubCredential;
  }> {
    const perSession = `outfitter-github-token-${session.id}`;
    const own = await this.accessSecretOrEmpty(perSession);
    if (own) {
      console.log(`[secrets] session ${session.id}: using ${perSession}`);
      return { token: own, credential: "session" };
    }
    if (!session.repo) return { token: "", credential: "none" };
    const minted = await this.app.mint(session.repo, permissions);
    if (minted.ok) {
      console.log(`[secrets] session ${session.id}: using a GitHub App installation token`);
      return { token: minted.token, expiresAt: minted.expiresAt, credential: "app" };
    }
    if (minted.reason !== "not-configured") {
      console.warn(`[secrets] session ${session.id}: GitHub App token ${minted.reason}; not using ${GITHUB_TOKEN_DEFAULT_SECRET}`);
      const { ok: _ok, reason, ...context } = minted;
      return {
        token: "",
        appFailure: reason,
        ...(Object.keys(context).length > 0 ? { appFailureContext: context } : {}),
        credential: "none",
      };
    }
    // E9 security review: a Drive a remote caller drives never holds the org-wide PAT, even behind
    // agentd's git proxy. buildRunSpec refuses the run (missing GitHub token) instead.
    if (isA2ASession(session)) {
      console.warn(`[secrets] session ${session.id}: A2A session, not using ${GITHUB_TOKEN_DEFAULT_SECRET}`);
      return { token: "", credential: "none" };
    }
    const shared = await this.accessSecretOrEmpty(GITHUB_TOKEN_DEFAULT_SECRET);
    if (shared) {
      console.log(
        `[secrets] session ${session.id}: ${perSession} not set; using ${GITHUB_TOKEN_DEFAULT_SECRET}`,
      );
    }
    return { token: shared, credential: shared ? "default" : "none" };
  }

  /** The tape's own key, else (only when `fallback`) the org-wide default. An A2A session passes
   * `fallback: false`: a remote caller never spends the org-wide key. */
  private async litellmKeyForGuru(guruId: string, fallback: boolean): Promise<{ key: string; source: "guru" | "default" | "none" }> {
    const key = await this.accessSecretOrEmpty(`outfitter-litellm-key-${guruId}`);
    if (!fallback) {
      // A copy of the org-wide key in the tape's secret is still the org-wide key.
      if (!key || key.trim() === (await this.defaultLitellmKey()).trim()) return { key: "", source: "none" };
      return { key, source: "guru" };
    }
    if (key) return { key, source: "guru" };
    const shared = await this.defaultLitellmKey();
    return { key: shared, source: shared ? "default" : "none" };
  }

  /** A per-tape secret that only copies the org-wide key is not a key of its own. */
  async hasDedicatedLitellmKey(guruId: string): Promise<boolean> {
    const own = await this.accessSecretOrEmpty(`outfitter-litellm-key-${guruId}`);
    if (!own) return false;
    return own.trim() !== (await this.defaultLitellmKey()).trim();
  }

  async defaultLitellmKey(): Promise<string> {
    return this.accessSecretOrEmpty("outfitter-litellm-key-default");
  }

  private async accessSecretOrEmpty(secretId: string): Promise<string> {
    try {
      return await this.fetchSecret(secretId);
    } catch (err) {
      if (!isSecretAbsentError(err)) throw err;
      console.warn(`[secrets] ${secretId} not found (or disabled) in Secret Manager; resolving to ""`);
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
 * (network, auth, 403) is a real failure. */
function isSecretNotFoundError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { response?: { status?: number }; code?: number | string; status?: number };
  const status = e.response?.status ?? e.code ?? e.status;
  return status === 404 || status === "404" || status === 5;
}

/** True when a credential secret has no value to read: not found, or its latest version is
 * disabled or destroyed. The operator page removes a secret by disabling every version
 * (`disableAllEnabled`), and Secret Manager then answers `versions/latest:access` with
 * FAILED_PRECONDITION ("... is in DISABLED state"), not a 404. Counting that as a failure would
 * make a GitHub App removed from the operator page read as `unavailable` and block every repo
 * run (PR #161 review). */
export function isSecretAbsentError(err: unknown): boolean {
  if (isSecretNotFoundError(err)) return true;
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    response?: { status?: number; data?: { error?: { status?: string; message?: string } } };
    code?: number | string;
    message?: string;
  };
  const precondition = e.response?.status === 400 || e.response?.data?.error?.status === "FAILED_PRECONDITION" || e.code === 9;
  const message = `${e.response?.data?.error?.message ?? ""} ${e.message ?? ""}`;
  return precondition && /\b(DISABLED|DESTROYED) state\b/.test(message);
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
   * exist yet. Returns that version's number (Secret Manager numbers from 1). `value` is the
   * caller's responsibility to validate/trim -- this just stores it. */
  addVersion(secretName: string, value: string): Promise<number>;
  /** Disables every currently-enabled version (does not destroy anything, so it's recoverable from
   * the console). A no-op if the secret doesn't exist or has no enabled versions. */
  disableAllEnabled(secretName: string): Promise<void>;
  /** Disables one version. A missing version is a no-op. Other versions stay as they are. */
  disableVersion(secretName: string, version: number): Promise<void>;
  /** The latest enabled version's plaintext, or undefined if the secret doesn't exist / has no
   * enabled version. Used for masking and as the "test the stored value" fallback when
   * POST /api/operator/secrets/:name/test is called with no explicit value. */
  accessLatest(secretName: string): Promise<string | undefined>;
  /** That version's plaintext, or undefined when it is missing or not enabled. */
  accessVersion(secretName: string, version: number): Promise<string | undefined>;
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
    const value = await this.readVersion(secretName, versionNumber(latest.name));
    return { set: true, masked: maskTail(value), updatedAt: latest.createTime };
  }

  async addVersion(secretName: string, value: string): Promise<number> {
    const client = await this.getAuthClient();
    await this.ensureSecretExists(client, secretName);
    const res = await client.request<{ name?: string }>({
      url: `${this.secretUrl(secretName)}:addVersion`,
      method: "POST",
      data: { payload: { data: Buffer.from(value, "utf8").toString("base64") } },
    });
    const version = versionNumber(res.data.name ?? "");
    if (!version) throw new Error("secret manager addVersion returned no version");
    return version;
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

  async disableVersion(secretName: string, version: number): Promise<void> {
    const client = await this.getAuthClient();
    try {
      await client.request({
        url: `${this.secretUrl(secretName)}/versions/${version}:disable`,
        method: "POST",
      });
    } catch (err) {
      if (isSecretNotFoundError(err)) return;
      throw err;
    }
  }

  async accessLatest(secretName: string): Promise<string | undefined> {
    const versions = await this.listEnabledVersionsDesc(secretName);
    const latest = versions[0];
    if (!latest) return undefined;
    return this.readVersion(secretName, versionNumber(latest.name));
  }

  async accessVersion(secretName: string, version: number): Promise<string | undefined> {
    try {
      return await this.readVersion(secretName, version);
    } catch (err) {
      if (isSecretAbsentError(err)) return undefined;
      throw err;
    }
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

  private async readVersion(secretName: string, version: number): Promise<string> {
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
 * are appended in order (last = newest) and numbered from 1, like Secret Manager. A disabled
 * version keeps its number. */
export class MemorySecretAdmin implements SecretAdmin {
  private readonly secrets = new Map<string, MemorySecretVersion[]>();

  async info(secretName: string): Promise<SecretVersionInfo> {
    const latest = this.latestEnabled(secretName);
    if (!latest) return { set: false };
    return { set: true, masked: maskTail(latest.value), updatedAt: latest.createdAt };
  }

  async addVersion(secretName: string, value: string): Promise<number> {
    const versions = this.secrets.get(secretName) ?? [];
    versions.push({ value, enabled: true, createdAt: new Date().toISOString() });
    this.secrets.set(secretName, versions);
    return versions.length;
  }

  async disableAllEnabled(secretName: string): Promise<void> {
    for (const version of this.secrets.get(secretName) ?? []) version.enabled = false;
  }

  async disableVersion(secretName: string, version: number): Promise<void> {
    const found = this.secrets.get(secretName)?.[version - 1];
    if (!found) return;
    found.enabled = false;
  }

  async accessLatest(secretName: string): Promise<string | undefined> {
    return this.latestEnabled(secretName)?.value;
  }

  async accessVersion(secretName: string, version: number): Promise<string | undefined> {
    const found = this.secrets.get(secretName)?.[version - 1];
    if (!found?.enabled) return undefined;
    return found.value;
  }

  private latestEnabled(secretName: string): MemorySecretVersion | undefined {
    const versions = this.secrets.get(secretName) ?? [];
    for (let i = versions.length - 1; i >= 0; i--) {
      if (versions[i].enabled) return versions[i];
    }
    return undefined;
  }
}

const APP_SECRET_NAMES = new Set<string>([
  GITHUB_APP_ID_SECRET,
  GITHUB_APP_KEY_SECRET,
  GITHUB_APP_INSTALLATION_SECRET,
  GITHUB_APP_SLUG_SECRET,
]);

const APP_SECRET_CACHE_TTL_MS = 60_000;

interface CachedSecretAccess {
  value: string | undefined;
  readAt: number;
}

/** Short TTL for the four GitHub App secret names the session page reads on every GET.
 * Other names always hit `inner` (per-session PATs, LiteLLM keys, and subscription secrets stay
 * fresh). Subscription plaintext is never cached. A throw is not stored. `addVersion`,
 * `disableAllEnabled`, and `disableVersion` drop that name first, so the next read sees the
 * write. `info` and `accessVersion` stay uncached. */
export class AppSecretCache implements SecretAdmin {
  private readonly inner: SecretAdmin;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedSecretAccess>();

  constructor(inner: SecretAdmin, now: () => number = Date.now) {
    this.inner = inner;
    this.now = now;
  }

  info(secretName: string): Promise<SecretVersionInfo> {
    return this.inner.info(secretName);
  }

  async addVersion(secretName: string, value: string): Promise<number> {
    this.cache.delete(secretName);
    return this.inner.addVersion(secretName, value);
  }

  async disableAllEnabled(secretName: string): Promise<void> {
    this.cache.delete(secretName);
    await this.inner.disableAllEnabled(secretName);
  }

  async disableVersion(secretName: string, version: number): Promise<void> {
    this.cache.delete(secretName);
    await this.inner.disableVersion(secretName, version);
  }

  accessVersion(secretName: string, version: number): Promise<string | undefined> {
    return this.inner.accessVersion(secretName, version);
  }

  async accessLatest(secretName: string): Promise<string | undefined> {
    if (!APP_SECRET_NAMES.has(secretName)) return this.inner.accessLatest(secretName);
    const hit = this.cache.get(secretName);
    if (hit && this.now() - hit.readAt < APP_SECRET_CACHE_TTL_MS) return hit.value;
    try {
      const value = await this.inner.accessLatest(secretName);
      this.cache.set(secretName, { value, readAt: this.now() });
      return value;
    } catch (err) {
      this.cache.delete(secretName);
      throw err;
    }
  }
}
