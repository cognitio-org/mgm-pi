/**
 * `Store` implementation (see ./lib.ts) backed by the Outfitter cloud API instead of a local git
 * clone. Selected by MGM_TELEPORT_STORE=outfitter (see ./store-factory.ts); the target is
 * OUTFITTER_API (e.g. https://outfitter-api-hqt4zwr5za-uc.a.run.app).
 *
 * Auth, two modes (see ../../../../outfitter/packages/api/src/auth.ts for what the API accepts):
 *   - OUTFITTER_TOKEN: sent as `Authorization: Bearer <token>`. Only meaningful against the API
 *     running with OUTFITTER_DEV=1 today -- dev mode accepts any (or no) bearer and identifies the
 *     caller as dev@localhost; there is no server-side personal-token verification yet.
 *   - OUTFITTER_IAP_CLIENT_ID: no token configured, so a Google identity token for this audience is
 *     minted by shelling out to `gcloud auth print-identity-token --audiences=<id>` (the currently
 *     active gcloud account -- never hardcoded here) and sent the same way, `Authorization: Bearer`.
 *     Google's Identity-Aware Proxy accepts that header on programmatic (non-browser) requests: IAP
 *     verifies it itself and forwards to the API with x-goog-iap-jwt-assertion set, which is what
 *     auth.ts's identityFromRequest already verifies -- no API change needed for this path.
 * Neither token is ever written to disk by this module.
 *
 * Before get() returns a session with an active cloud run, it stops the run (POST .../stop) and
 * polls GET /api/sessions/:id until the run is no longer active, so the exported transcript is
 * complete. --force (opts.force) skips this and pulls whatever has been persisted so far.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Manifest, SessionRef, Store, Warn } from "./lib.ts";

const execFileAsync = promisify(execFile);

// Run states the API considers "active" -- mirrors ACTIVE_RUN_STATES / memory.ts's findActiveForSession.
const ACTIVE_RUN_STATES = new Set(["queued", "provisioning", "running", "idle", "stopping"]);

export type FetchFn = typeof fetch;
/** Runs `gcloud auth print-identity-token --audiences=<audience>` and returns the trimmed token.
 * Injectable so tests never shell out to a real gcloud. */
export type GcloudTokenFn = (audience: string) => Promise<string>;

async function defaultGcloudIdentityToken(audience: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gcloud", ["auth", "print-identity-token", `--audiences=${audience}`]);
    const token = stdout.trim();
    if (!token) throw new Error("gcloud printed an empty token");
    return token;
  } catch (err: any) {
    const detail = err?.stderr ? String(err.stderr).trim() : err?.message ?? String(err);
    throw new Error(
      `teleport: could not get a Google identity token for OUTFITTER_IAP_CLIENT_ID (gcloud auth print-identity-token failed): ${detail}. ` +
        `Sign in with 'gcloud auth login' as your mgmonteleone.com account, or set OUTFITTER_TOKEN instead.`,
    );
  }
}

type SessionSummary = {
  id: string;
  name?: string;
  status: "open" | "closed";
  runState?: string;
  guru: string;
  repo: string | null;
  branch?: string;
  parentId?: string;
  cost: number;
  updatedAt: string;
};

export type OutfitterStoreOptions = {
  /** Base URL of the Outfitter API. Defaults to OUTFITTER_API. */
  apiBase?: string;
  /** Personal bearer token. Defaults to OUTFITTER_TOKEN. */
  token?: string;
  /** IAP audience (resource path or OAuth client id) to mint an identity token for. Defaults to
   * OUTFITTER_IAP_CLIENT_ID. Only used when `token` is not set. */
  iapClientId?: string;
  fetchFn?: FetchFn;
  getGcloudIdentityToken?: GcloudTokenFn;
  warn?: Warn;
  /** How long get() waits for an active run to stop before giving up. Default 90s. */
  stopTimeoutMs?: number;
  /** Poll interval while waiting for the run to stop. Default 2s. */
  pollIntervalMs?: number;
  /** Injectable sleep, so tests don't wait for real. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (ms since epoch), paired with `sleep` so a fake sleep can fast-forward it
   * without the timeout loop falling back to real wall-clock time. Defaults to Date.now. */
  now?: () => number;
};

export class OutfitterStore implements Store {
  private apiBase: string;
  private token?: string;
  private iapClientId?: string;
  private fetchFn: FetchFn;
  private getGcloudIdentityToken: GcloudTokenFn;
  private warn: Warn;
  private stopTimeoutMs: number;
  private pollIntervalMs: number;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;
  private cachedIapToken?: string;

  constructor(opts: OutfitterStoreOptions = {}) {
    const apiBase = opts.apiBase ?? process.env.OUTFITTER_API;
    if (!apiBase) throw new Error("teleport: MGM_TELEPORT_STORE=outfitter requires OUTFITTER_API (the Outfitter API base URL) to be set.");
    this.apiBase = apiBase.replace(/\/+$/, "");
    this.token = opts.token ?? process.env.OUTFITTER_TOKEN;
    this.iapClientId = opts.iapClientId ?? process.env.OUTFITTER_IAP_CLIENT_ID;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.getGcloudIdentityToken = opts.getGcloudIdentityToken ?? defaultGcloudIdentityToken;
    this.warn = opts.warn ?? (() => {});
    this.stopTimeoutMs = opts.stopTimeoutMs ?? 90_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2_000;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? (() => Date.now());
  }

  private hostLabel(): string {
    try {
      return `outfitter:${new URL(this.apiBase).hostname}`;
    } catch {
      return "outfitter";
    }
  }

  private async authHeader(): Promise<string> {
    if (this.token) return `Bearer ${this.token}`;
    if (this.iapClientId) {
      if (!this.cachedIapToken) this.cachedIapToken = await this.getGcloudIdentityToken(this.iapClientId);
      return `Bearer ${this.cachedIapToken}`;
    }
    throw new Error(
      "teleport: no Outfitter auth configured -- set OUTFITTER_TOKEN (dev mode) or OUTFITTER_IAP_CLIENT_ID (real deployments, uses 'gcloud auth print-identity-token').",
    );
  }

  private async request(method: string, path: string, body?: string): Promise<Response> {
    const headers: Record<string, string> = { Authorization: await this.authHeader() };
    if (body !== undefined) headers["Content-Type"] = "application/x-ndjson";
    const res = await this.fetchFn(`${this.apiBase}${path}`, { method, headers, body });
    if (res.status === 401) {
      // 401 from a fresh identity token means the token itself is bad or its audience is wrong;
      // re-minting on retry would just fail the same way, but clear the cache so a later manual
      // retry after re-auth does mint a fresh one instead of reusing the stale cached token.
      this.cachedIapToken = undefined;
      throw new Error(
        "teleport: Outfitter API returned 401 Unauthorized. Sign in with 'gcloud auth login' as your mgmonteleone.com account (IAP mode), or check OUTFITTER_TOKEN (dev mode).",
      );
    }
    if (res.status === 403) {
      throw new Error("teleport: Outfitter API returned 403 Forbidden -- your account is not allowed to use this Outfitter deployment.");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`teleport: Outfitter API ${method} ${path} failed: ${res.status} ${text.trim()}`);
    }
    return res;
  }

  async list(): Promise<SessionRef[]> {
    const res = await this.request("GET", "/api/sessions");
    const summaries = (await res.json()) as SessionSummary[];
    const host = this.hostLabel();
    return summaries
      .map((s) => ({
        id: s.id,
        name: s.name,
        cwd: "/workspace",
        repo: s.repo ?? undefined,
        branch: s.branch,
        updatedAt: s.updatedAt,
        host,
      }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  }

  /** Stops an active run for `id` and waits until it is no longer active, unless force is set.
   * Returns without waiting if there was never an active run. Throws after stopTimeoutMs. */
  private async ensureStopped(id: string, force: boolean | undefined): Promise<void> {
    const session = await this.getSession(id);
    if (!session.runState || !ACTIVE_RUN_STATES.has(session.runState)) return; // nothing to stop
    if (force) {
      this.warn(`teleport: pulling ${id.slice(0, 8)} while its cloud run is still ${session.runState} (--force) -- the transcript tail may be missing.`);
      return;
    }

    const stopRes = await this.fetchFn(`${this.apiBase}/api/sessions/${id}/stop`, {
      method: "POST",
      headers: { Authorization: await this.authHeader() },
    });
    if (stopRes.status === 404) return; // "no active run" -- already stopped between our check and this call
    if (!stopRes.ok && stopRes.status !== 409) {
      const text = await stopRes.text().catch(() => "");
      throw new Error(`teleport: could not stop the cloud run for ${id.slice(0, 8)}: ${stopRes.status} ${text.trim()}`);
    }

    const deadline = this.now() + this.stopTimeoutMs;
    for (;;) {
      const polled = await this.getSession(id);
      if (!polled.runState || !ACTIVE_RUN_STATES.has(polled.runState)) return;
      if (this.now() >= deadline) {
        throw new Error(
          `teleport: timed out after ${Math.round(this.stopTimeoutMs / 1000)}s waiting for ${id.slice(0, 8)}'s cloud run to stop (still ${polled.runState}). ` +
            "Retry, or pass --force to pull the transcript as it stands.",
        );
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async getSession(id: string): Promise<{ runState?: string; name?: string; repo: string | null; branch?: string; updatedAt: string; checkpoint?: { head?: string } }> {
    const res = await this.request("GET", `/api/sessions/${id}`);
    return res.json();
  }

  async get(id: string, opts: { force?: boolean } = {}): Promise<{ file: string; manifest: Manifest }> {
    await this.ensureStopped(id, opts.force);

    const [exportRes, session] = await Promise.all([this.request("GET", `/api/sessions/${id}/export.jsonl`), this.getSession(id)]);
    const file = await exportRes.text();

    const manifest: Manifest = {
      id,
      name: session.name,
      host: this.hostLabel(),
      cwd: "/workspace",
      pushedAt: session.updatedAt,
    };
    if (session.repo && session.branch) {
      manifest.repo = {
        remote: `https://github.com/${session.repo}`,
        ownerRepo: session.repo,
        branch: session.branch,
        head: session.checkpoint?.head ?? "",
      };
    }
    return { file, manifest };
  }

  async put(id: string, jsonl: string, _manifest: Manifest): Promise<void> {
    // The API derives everything it needs from the JSONL header (PUT /api/sessions/:id/import
    // creates the session if it doesn't exist yet); the manifest is GitStore-local metadata that
    // the Outfitter API has no use for.
    await this.request("PUT", `/api/sessions/${id}/import`, jsonl);
  }
}
