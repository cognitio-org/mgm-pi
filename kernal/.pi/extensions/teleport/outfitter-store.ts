/**
 * `Store` implementation (see ./lib.ts) backed by the Outfitter cloud API instead of a local git
 * clone. Selected by KERNAL_TELEPORT_STORE=outfitter (see ./store-factory.ts); the target is
 * OUTFITTER_API -- the Outfitter **link** service's origin (e.g.
 * https://outfitter-link-hqt4zwr5za-uc.a.run.app), not the browser-facing IAP-fronted `outfitter-api`
 * service. The link service has no IAP session at all (see
 * ../../../../outfitter/docs/protocol.md's "Two origins") and instead accepts exactly one
 * credential: a personal API token.
 *
 * Auth: OUTFITTER_TOKEN, sent as `Authorization: Bearer <token>` (E4.1b, see
 * ../../../../outfitter/packages/api/src/auth.ts's identityFromLinkRequest /
 * identityFromApiToken). Create a token on the Outfitter web UI's Tokens page (`/tokens`); it
 * shows the exact `export OUTFITTER_API=...` / `export OUTFITTER_TOKEN=...` /
 * `export KERNAL_TELEPORT_STORE=outfitter` lines to copy into your shell. The token is never written
 * to disk by this module.
 *
 * An earlier version of this store also tried an `OUTFITTER_IAP_CLIENT_ID` mode (minting a Google
 * identity token via `gcloud auth print-identity-token` and sending it the same way, on the theory
 * that IAP would verify it like browser traffic). That was verified NOT working against a real
 * deployed API on 2026-09-21 (critic review, outfitter/docs/reports/critic-review-pr15.md):
 * `gcloud auth print-identity-token` cannot mint a token audienced to Google's IAP OAuth client for
 * a user account, and IAP enabled directly on a Cloud Run service uses that Google-managed OAuth
 * client, whose credentials are never available for programmatic access at all. Personal API
 * tokens on a separate, non-IAP "link" service (E4.1b) are the fix, not a workaround: the IAP mode
 * has been removed entirely rather than left in as dead code.
 *
 * Before get() returns a session with an active cloud run, it stops the run (POST .../stop) and
 * polls GET /api/sessions/:id until the run is no longer active, so the exported transcript is
 * complete. --force (opts.force) skips this and pulls whatever has been persisted so far.
 */
import type { Manifest, SessionRef, Store, Warn } from "./lib.ts";

// Run states the API considers "active" -- mirrors ACTIVE_RUN_STATES / memory.ts's findActiveForSession.
const ACTIVE_RUN_STATES = new Set(["queued", "provisioning", "running", "idle", "stopping"]);

export type FetchFn = typeof fetch;

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
  /** Base URL of the Outfitter link service. Defaults to OUTFITTER_API. */
  apiBase?: string;
  /** Personal bearer token. Defaults to OUTFITTER_TOKEN. */
  token?: string;
  fetchFn?: FetchFn;
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
  private token: string;
  private fetchFn: FetchFn;
  private warn: Warn;
  private stopTimeoutMs: number;
  private pollIntervalMs: number;
  private sleep: (ms: number) => Promise<void>;
  private now: () => number;

  constructor(opts: OutfitterStoreOptions = {}) {
    const apiBase = opts.apiBase ?? process.env.OUTFITTER_API;
    if (!apiBase) throw new Error("teleport: KERNAL_TELEPORT_STORE=outfitter requires OUTFITTER_API (the Outfitter link service's origin) to be set.");
    this.apiBase = apiBase.replace(/\/+$/, "");
    const token = opts.token ?? process.env.OUTFITTER_TOKEN;
    if (!token) {
      throw new Error(
        "teleport: KERNAL_TELEPORT_STORE=outfitter requires OUTFITTER_TOKEN (a personal API token -- create one on the Outfitter web UI's Tokens page).",
      );
    }
    this.token = token;
    this.fetchFn = opts.fetchFn ?? fetch;
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

  private authHeader(): string {
    return `Bearer ${this.token}`;
  }

  private async request(method: string, path: string, body?: string, extraHeaders?: Record<string, string>): Promise<Response> {
    const headers: Record<string, string> = { ...extraHeaders, Authorization: this.authHeader() };
    if (body !== undefined) headers["Content-Type"] = "application/x-ndjson";
    const res = await this.fetchFn(`${this.apiBase}${path}`, { method, headers, body });
    if (res.status === 401) {
      throw new Error(
        "teleport: Outfitter API returned 401 Unauthorized. OUTFITTER_TOKEN was rejected; create a new token on the Outfitter Tokens page.",
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

    // Code review M2/N2 (docs/reports/code-review-pr15.md): a run already `stopping` (e.g. a
    // previous ensureStopped call's own /stop, or the web UI's Stop button, or an earlier timed-out
    // retry of this same call) doesn't need another /stop -- POST /api/sessions/:id/stop returns
    // 404 or 200 only; it never returns 409 (that tolerance was dead code, written against a status
    // code the route doesn't produce). Go straight to polling instead of re-POSTing.
    if (session.runState !== "stopping") {
      const stopRes = await this.fetchFn(`${this.apiBase}/api/sessions/${id}/stop`, {
        method: "POST",
        headers: { Authorization: this.authHeader() },
      });
      if (stopRes.status === 404) return; // "no active run" -- already stopped between our check and this call
      if (!stopRes.ok) {
        const text = await stopRes.text().catch(() => "");
        throw new Error(`teleport: could not stop the cloud run for ${id.slice(0, 8)}: ${stopRes.status} ${text.trim()}`);
      }
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

  async put(id: string, jsonl: string, manifest: Manifest): Promise<void> {
    // Repo rides on headers so the JSONL body stays a pi transcript: x-outfitter-repo, x-outfitter-branch, x-outfitter-base, x-outfitter-head.
    await this.request("PUT", `/api/sessions/${id}/import`, jsonl, repoHeaders(manifest));
  }
}

/** `x-outfitter-base` only when the manifest repo already has a base; Manifest has none today, so it is omitted. */
function repoHeaders(manifest: Manifest): Record<string, string> | undefined {
  const repo = manifest.repo;
  if (!repo) return undefined;
  const headers: Record<string, string> = {
    "x-outfitter-repo": repo.ownerRepo,
    "x-outfitter-branch": repo.branch,
    "x-outfitter-head": repo.head,
  };
  const base = "base" in repo ? (repo as { base?: unknown }).base : undefined;
  if (typeof base === "string" && base.length > 0) headers["x-outfitter-base"] = base;
  return headers;
}
