/**
 * Drive previews, the api side (#217, docs/specs/drive-previews.md).
 *
 * Each run gets one ngrok credential, minted at its first run.spec, whose ACL lets it bind only
 * internal endpoints under the run's own label (`*.<label>.internal`). agentd binds
 * `https://p<port>.<label>.internal` with it when the model calls `preview`, then sends
 * `preview.open`. Only here, with the account's API key, is the public side made: a cloud endpoint
 * `https://<128-bit id>.<PREVIEW_DOMAIN>` whose Traffic Policy forwards to that internal endpoint.
 * The sandbox can't reach or change that policy, so it can't make a preview public, or open one
 * for another run.
 *
 * Two policies (owner decision, 2026-09-27):
 * - secure: Google sign-in at ngrok's edge (our OAuth client when configured), then deny unless the
 *   email is one IAP lets into Outfitter (PREVIEW_ALLOW: IAP_MEMBERS plus the operators). Empty
 *   allowlist: nobody gets in.
 * - share: a public, time-limited link. A first-visit notice page says it's an AI-built preview
 *   before the app is shown.
 * Endpoints go with their job (preview.close), their run (closeRun), or their deadline (sweep); the
 * credential goes with its run. sweep() also removes what a crash left behind on ngrok's side.
 */
import { randomBytes } from "node:crypto";
import type { Config } from "./config.ts";
import type { NgrokApi } from "./ngrok-api.ts";
import type { Preview, Run, Store } from "./store/types.ts";

export const MAX_OPEN_PREVIEWS_PER_RUN = 8;
/** An endpoint or credential on ngrok's side with no record here is only swept once it's this old,
 * so a preview being created (endpoint made, record not yet written) is never taken for an orphan. */
export const ORPHAN_GRACE_MS = 5 * 60_000;
const ACK_COOKIE = "kernal_preview_ack";
const LIVE_RUN_STATES = new Set(["queued", "provisioning", "running", "idle", "stopping"]);
const CREDENTIAL_PURPOSE = "outfitter-preview";

// ---------- pure helpers ----------

/** The run's label in its internal endpoint names: DNS-safe, unique per run. */
export function runLabel(runId: string): string {
  return `r${runId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40)}`;
}

export function internalUrlFor(label: string, port: number): string {
  return `https://p${port}.${label}.internal`;
}

export function validPreviewPort(port: unknown): port is number {
  return typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535;
}

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

/** PREVIEW_ALLOW entries → emails and domains. Anything else (group:, typos) is dropped: a CEL
 * expression is built from these, so only strictly-shaped values get in. */
export function parseAllowlist(entries: string[]): { emails: string[]; domains: string[]; ignored: string[] } {
  const emails = new Set<string>();
  const domains = new Set<string>();
  const ignored: string[] = [];
  for (const raw of entries) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    const v = e.startsWith("user:") ? e.slice(5) : e.startsWith("domain:") ? e : e;
    if (v.startsWith("domain:")) {
      const d = v.slice(7);
      if (DOMAIN.test(d)) domains.add(d); else ignored.push(raw);
    } else if (EMAIL.test(v)) {
      emails.add(v);
    } else {
      ignored.push(raw);
    }
  }
  return { emails: [...emails].sort(), domains: [...domains].sort(), ignored };
}

/** The CEL condition "this signed-in email may open it". `false` when nobody is allowed. */
export function allowExpression(allow: { emails: string[]; domains: string[] }): string {
  const email = "actions.ngrok.oauth.identity.email";
  const parts: string[] = [];
  if (allow.emails.length > 0) parts.push(`${email} in [${allow.emails.map((e) => `'${e}'`).join(", ")}]`);
  for (const d of allow.domains) parts.push(`${email}.endsWith('@${d}')`);
  return parts.length > 0 ? parts.join(" || ") : "false";
}

const RESPONSE_HEADERS = {
  on_http_response: [
    { actions: [{ type: "add-headers", config: { headers: { "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" } } }] },
  ],
};

/** Secure preview: Google sign-in, then only the allowlist, then the app. JSON (valid YAML). */
export function securePolicy(internalUrl: string, allow: { emails: string[]; domains: string[] }, oauth?: { clientId: string; clientSecret: string }): string {
  return JSON.stringify({
    on_http_request: [
      {
        actions: [{
          type: "oauth",
          config: oauth
            ? {
              provider: "google",
              client_id: oauth.clientId,
              client_secret: oauth.clientSecret,
              // ngrok requires the email scope with our own client (a managed app implies it).
              scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email"],
            }
            : { provider: "google" },
        }],
      },
      { expressions: [`!(${allowExpression(allow)})`], actions: [{ type: "deny", config: { status_code: 403 } }] },
      { actions: [{ type: "forward-internal", config: { url: internalUrl } }] },
    ],
    ...RESPONSE_HEADERS,
  });
}

function noticePage(expiresAt: string): string {
  return [
    "<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>",
    "<meta name=robots content='noindex,nofollow'><title>Preview</title>",
    "<body style='font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:12vh auto;padding:0 1rem'>",
    "<h1 style='font-size:1.3rem'>A preview of an app an AI agent is building</h1>",
    "<p>Someone shared a work-in-progress app from a Kernal session. It was written by an AI agent and runs in a temporary sandbox.",
    " It isn't a Kernal or Google page: <strong>don't enter passwords, codes or payment details.</strong></p>",
    `<p>The link stops working ${expiresAt.slice(0, 16).replace("T", " ")} UTC, or sooner when the session stops.</p>`,
    `<p><a href='/?${ACK_COOKIE}=1' style='font-weight:600'>Continue to the preview</a></p></body></html>`,
  ].join("");
}

/** Share link: a notice on first visit (cookie-acknowledged), then the app. */
export function sharePolicy(internalUrl: string, expiresAt: string, now: Date): string {
  const maxAge = Math.max(60, Math.floor((Date.parse(expiresAt) - now.getTime()) / 1000));
  return JSON.stringify({
    on_http_request: [
      {
        expressions: [`'${ACK_COOKIE}' in req.url.query_params`],
        actions: [{
          type: "custom-response",
          config: {
            status_code: 302,
            headers: { location: "/", "set-cookie": `${ACK_COOKIE}=1; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` },
          },
        }],
      },
      {
        expressions: [`!('${ACK_COOKIE}' in req.cookies)`],
        actions: [{
          type: "custom-response",
          config: { status_code: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body: noticePage(expiresAt) },
        }],
      },
      { actions: [{ type: "forward-internal", config: { url: internalUrl } }] },
    ],
    ...RESPONSE_HEADERS,
  });
}

// ---------- the service ----------

export type OpenResult = { url: string; expiresAt?: string } | { error: string };

export class PreviewService {
  private readonly store: Store;
  private readonly config: Config;
  private readonly ngrok: NgrokApi | undefined;
  private readonly now: () => Date;
  private readonly log: (msg: string, detail?: Record<string, unknown>) => void;
  private readonly allow: { emails: string[]; domains: string[] };

  constructor(opts: {
    store: Store;
    config: Config;
    ngrok?: NgrokApi;
    now?: () => Date;
    log?: (msg: string, detail?: Record<string, unknown>) => void;
  }) {
    this.store = opts.store;
    this.config = opts.config;
    this.ngrok = opts.ngrok;
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? (() => {});
    const parsed = parseAllowlist(opts.config.previewAllow);
    this.allow = parsed;
    if (parsed.ignored.length > 0) this.log("previews: ignoring PREVIEW_ALLOW entries ngrok can't check", { ignored: parsed.ignored });
  }

  get enabled(): boolean {
    return Boolean(this.ngrok && this.config.previewDomain);
  }

  /**
   * run.spec's preview config. Mints the run's credential on first use and records it on the run;
   * later calls (a reconnect) return the same domain without a token, since agentd honours only
   * its first run.spec and keeps the credential it already has. undefined: previews are off, or
   * the credential couldn't be made (the run starts without previews rather than not at all).
   */
  async runSpecConfig(run: Run): Promise<{ internalDomain: string; token?: string } | undefined> {
    if (!this.enabled) return undefined;
    const existing = (await this.store.runs.findById(run.id))?.preview ?? run.preview;
    if (existing) return { internalDomain: `${existing.label}.internal` };
    const label = runLabel(run.id);
    try {
      const cred = await this.ngrok!.createCredential({
        description: `outfitter preview, run ${run.id}`.slice(0, 255),
        metadata: JSON.stringify({ purpose: CREDENTIAL_PURPOSE, runId: run.id, sessionId: run.sessionId, createdAt: this.now().toISOString() }),
        acl: [`bind:*.${label}.internal`],
      });
      if (!cred.token) throw new Error("ngrok returned no token");
      await this.store.runs.update(run.id, { preview: { label, credentialId: cred.id } });
      return { internalDomain: `${label}.internal`, token: cred.token };
    } catch (err) {
      this.log("previews: couldn't mint the run's ngrok credential; this run has no previews", { runId: run.id, err: String(err) });
      return undefined;
    }
  }

  /** preview.open: the public URL for `port` in `runId`'s sandbox. */
  async open(runId: string, port: number, share: boolean, internalUrlFromAgent?: string): Promise<OpenResult> {
    if (!this.enabled) return { error: "not-configured" };
    if (!validPreviewPort(port)) return { error: "port-not-allowed" };
    const run = await this.store.runs.findById(runId);
    if (!run?.preview || !LIVE_RUN_STATES.has(run.state)) return { error: "not-configured" };
    const internalUrl = internalUrlFor(run.preview.label, port);
    // The api decides where the endpoint forwards; agentd's value is only checked, never used.
    if (internalUrlFromAgent && internalUrlFromAgent.replace(/\/+$/, "") !== internalUrl) return { error: "failed" };
    const open = await this.store.previews.findOpen(runId, port, share);
    if (open) return { url: open.url, ...(open.expiresAt ? { expiresAt: open.expiresAt } : {}) };
    if ((await this.store.previews.listOpenForRun(runId)).length >= MAX_OPEN_PREVIEWS_PER_RUN) return { error: "too-many" };

    const id = randomBytes(16).toString("hex");
    const url = `https://${id}.${this.config.previewDomain}`;
    const now = this.now();
    const ttl = Math.min(this.config.previewShareTtlSeconds, this.config.previewShareMaxSeconds);
    const expiresAt = share ? new Date(now.getTime() + ttl * 1000).toISOString() : undefined;
    const policy = share ? sharePolicy(internalUrl, expiresAt!, now) : securePolicy(internalUrl, this.allow, this.config.ngrokGoogleOauth);
    let endpointId: string;
    try {
      const ep = await this.ngrok!.createCloudEndpoint({
        url,
        trafficPolicy: policy,
        description: `outfitter preview, session ${run.sessionId} port ${port}${share ? " (share)" : ""}`.slice(0, 255),
        metadata: JSON.stringify({ purpose: CREDENTIAL_PURPOSE, previewId: id, runId, sessionId: run.sessionId, port, share, createdAt: now.toISOString() }),
      });
      endpointId = ep.id;
    } catch (err) {
      this.log("previews: creating the cloud endpoint failed", { runId, port, err: String(err) });
      return { error: "failed" };
    }
    const preview: Preview = {
      id, runId, sessionId: run.sessionId, port, share, url, endpointId, internalUrl,
      createdAt: now.toISOString(), ...(expiresAt ? { expiresAt } : {}),
    };
    try {
      await this.store.previews.insert(preview);
    } catch (err) {
      await this.ngrok!.deleteEndpoint(endpointId).catch(() => {});
      this.log("previews: recording the preview failed; endpoint removed", { runId, port, err: String(err) });
      return { error: "failed" };
    }
    return { url, ...(expiresAt ? { expiresAt } : {}) };
  }

  /** preview.close: every open preview of `port` in the run (secure and share). */
  async close(runId: string, port: number, reason = "closed"): Promise<void> {
    for (const p of await this.store.previews.listOpenForRun(runId)) {
      if (p.port === port) await this.closeOne(p, reason);
    }
  }

  /** Run end: all its previews, then its credential. Safe to call more than once. */
  async closeRun(runId: string, reason = "run ended"): Promise<void> {
    if (!this.ngrok) return;
    for (const p of await this.store.previews.listOpenForRun(runId)) await this.closeOne(p, reason);
    const run = await this.store.runs.findById(runId);
    if (run?.preview?.credentialId) {
      try {
        await this.ngrok.deleteCredential(run.preview.credentialId);
      } catch (err) {
        this.log("previews: deleting the run's credential failed; the sweeper retries", { runId, err: String(err) });
      }
    }
  }

  /**
   * The tick's cleanup: share links past their deadline, previews whose run is over, and, on
   * ngrok's side, preview endpoints nothing here knows about and credentials of runs that are over
   * (a crash between two steps, a closeRun that failed). Returns what it removed.
   */
  async sweep(): Promise<{ expired: number; deadRuns: number; orphanEndpoints: number; credentials: number }> {
    const out = { expired: 0, deadRuns: 0, orphanEndpoints: 0, credentials: 0 };
    if (!this.ngrok) return out;
    const now = this.now();
    const runLive = new Map<string, boolean>();
    const isLive = async (runId: string) => {
      if (!runLive.has(runId)) {
        const run = await this.store.runs.findById(runId);
        runLive.set(runId, Boolean(run && LIVE_RUN_STATES.has(run.state)));
      }
      return runLive.get(runId)!;
    };
    const open = await this.store.previews.listOpen();
    for (const p of open) {
      if (p.expiresAt && Date.parse(p.expiresAt) <= now.getTime()) {
        if (await this.closeOne(p, "expired")) out.expired++;
      } else if (!(await isLive(p.runId))) {
        if (await this.closeOne(p, "run ended")) out.deadRuns++;
      }
    }
    if (!this.config.previewDomain) return out;
    try {
      const known = new Set((await this.store.previews.listOpen()).map((p) => p.endpointId));
      for (const ep of await this.ngrok.listCloudEndpoints()) {
        if (known.has(ep.id) || !hostOf(ep.url).endsWith(`.${this.config.previewDomain}`)) continue;
        if (!olderThanGrace(ep.metadata, now)) continue;
        await this.ngrok.deleteEndpoint(ep.id);
        out.orphanEndpoints++;
      }
      for (const cred of await this.ngrok.listCredentials()) {
        const meta = parseMeta(cred.metadata);
        if (meta?.purpose !== CREDENTIAL_PURPOSE || typeof meta.runId !== "string") continue;
        if (!olderThanGrace(cred.metadata, now) || (await isLive(meta.runId))) continue;
        await this.ngrok.deleteCredential(cred.id);
        out.credentials++;
      }
    } catch (err) {
      this.log("previews: sweeping ngrok's side failed; next tick retries", { err: String(err) });
    }
    return out;
  }

  private async closeOne(p: Preview, reason: string): Promise<boolean> {
    try {
      await this.ngrok!.deleteEndpoint(p.endpointId);
    } catch (err) {
      // Left open here, so the next sweep tries again.
      this.log("previews: deleting a cloud endpoint failed", { previewId: p.id, err: String(err) });
      return false;
    }
    return (await this.store.previews.markClosed(p.id, this.now().toISOString(), reason)) !== null;
  }
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

function parseMeta(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try { const j = JSON.parse(raw); return j && typeof j === "object" ? j : undefined; } catch { return undefined; }
}

/** True when the resource's metadata says it was made more than ORPHAN_GRACE_MS ago. Missing or
 * unreadable createdAt counts as old: that's no resource this code made recently. */
function olderThanGrace(metadata: string | undefined, now: Date): boolean {
  const created = Date.parse(String(parseMeta(metadata)?.createdAt ?? ""));
  return !Number.isFinite(created) || now.getTime() - created > ORPHAN_GRACE_MS;
}
