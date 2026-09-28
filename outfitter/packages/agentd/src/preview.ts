/**
 * Loopback side of the Drive `preview` tool (docs/specs/drive-previews.md, #217). Sibling of the
 * browser listeners (browser-action.ts): its own port and token, the same loopback, token and peer
 * checks. agentd starts it only when run.spec carries preview config (`spec.preview` and
 * `secrets.ngrokAuthtoken`); the tool finds it through OUTFITTER_PREVIEW_PORT/_TOKEN.
 *
 *   POST   /previews        {port, jobId?, share?} -> 200 {url, port, expiresAt?}
 *   DELETE /previews/<port>                       -> 200 {closed: true}   (idempotent)
 *   GET    /previews                              -> 200 {previews: [...]}
 *   POST   /ide                                   -> 202 {requested: true}   (#273, the `vscode` tool)
 *
 * Errors are `{error, detail}`: nothing-listening 409, port-not-allowed 400, not-configured 503,
 * timeout 504, failed 502 (and forbidden 403 / not_found 404 / rejected 400 for bad calls).
 *
 * Opening one: check something listens on 127.0.0.1:<port>, start a LocalPreviewProxy for it, start
 * an ngrok agent binding `https://p<port>.<internalDomain>` (internal: unreachable from the
 * internet), then send `preview.open` up and wait for the api's `preview.result`, which carries the
 * public `https://<id>.kernal.run` URL it created. Closing (the tool, the tunnel dying, run end)
 * stops both and sends `preview.close`.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { peerUidFromProcNet } from "./browser-capture.js";
import { LocalPreviewProxy } from "./preview-proxy.js";
import { NgrokStartError, startNgrok, type NgrokTunnel } from "./ngrok-runner.js";
import type { DownPreviewResult, UpPreviewClose, UpPreviewOpen } from "./protocol.js";

export const PREVIEW_TOKEN_HEADER = "x-outfitter-preview-token";
/** How long agentd waits for the api to create the public endpoint. */
export const PREVIEW_API_WAIT_MS = 30_000;
const BODY_MAX = 4_000;
const PROBE_TIMEOUT_MS = 2_000;

export type PreviewError = "nothing-listening" | "port-not-allowed" | "not-configured" | "timeout" | "failed";
const STATUS: Record<PreviewError | "forbidden" | "not_found" | "rejected", number> = {
  "nothing-listening": 409, "port-not-allowed": 400, "not-configured": 503, timeout: 504, failed: 502,
  forbidden: 403, not_found: 404, rejected: 400,
};

type PreviewResultFrame = DownPreviewResult;

export interface PreviewInfo { port: number; url: string; jobId?: string; share?: boolean; expiresAt?: string }

type StartTunnel = (opts: { upstream: string; url: string; authtoken: string; onExit: (reason: string) => void }) => Promise<NgrokTunnel>;

export interface PreviewListenerOptions {
  /** e.g. `r1a2b3c.internal`; each preview binds `p<port>.<internalDomain>`. */
  internalDomain: string;
  authtoken: string;
  send: (frame: UpPreviewOpen | UpPreviewClose) => void;
  /** A person loaded a preview page (preview-proxy.ts isPageRequest). */
  onActivity?: () => void;
  /** Ports that are agentd's own (its other loopback listeners); never previewable. */
  reservedPorts?: () => Array<number | undefined>;
  /** When set, a Linux peer whose uid is not this value is refused. */
  peerUid?: number;
  waitMs?: number;
  onLog?: (line: string) => void;
  /** #273: the `vscode` tool asked for the browser IDE. No handler, or it answers undefined: this
   * Drive has none (404). */
  onIdeRequest?: () => { ok: true } | { error: "not-configured" | "too-many"; detail: string } | undefined;
  /** Tests: replaces the real ngrok agent. */
  startTunnel?: StartTunnel;
  /** The ngrok binary for the default startTunnel. */
  ngrokBin?: string;
}

interface Open {
  info: PreviewInfo;
  proxy: LocalPreviewProxy;
  tunnel: NgrokTunnel;
}

interface Waiter { resolve: (frame: PreviewResultFrame) => void; timer: ReturnType<typeof setTimeout> }

class PreviewFailure extends Error {
  readonly code: PreviewError;
  constructor(code: PreviewError, detail: string) {
    super(detail);
    this.code = code;
  }
}

/** The body the tool posts. */
export function parsePreviewRequest(body: unknown): { port: number; jobId?: string; share: boolean } | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const r = body as Record<string, unknown>;
  if (Object.keys(r).some((k) => k !== "port" && k !== "jobId" && k !== "share")) return undefined;
  if (typeof r.port !== "number" || !Number.isInteger(r.port)) return undefined;
  if (r.jobId !== undefined && (typeof r.jobId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(r.jobId))) return undefined;
  if (r.share !== undefined && typeof r.share !== "boolean") return undefined;
  return { port: r.port, ...(r.jobId !== undefined ? { jobId: r.jobId as string } : {}), share: r.share === true };
}

/** Whether something accepts TCP connections on 127.0.0.1:<port>. */
export function probePort(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(port, "127.0.0.1");
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

function tokenMatches(presented: string | undefined, expected: string): boolean {
  const got = Buffer.from(presented ?? "");
  const want = Buffer.from(expected);
  if (got.length !== want.length) {
    timingSafeEqual(want, want);
    return false;
  }
  return timingSafeEqual(got, want);
}

function loopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return; // drained and dropped, so the caller can still answer 400
      size += chunk.length;
      if (size > BODY_MAX) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return reject(new Error("body too large"));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { resolve(undefined); }
    });
    req.on("error", reject);
  });
}

export class PreviewListener {
  readonly token: string;
  port: number | undefined;
  private server: Server | undefined;
  private readonly open = new Map<number, Open>();
  private readonly opening = new Map<number, Promise<PreviewInfo>>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly opts: PreviewListenerOptions;
  private readonly waitMs: number;
  private readonly onLog: (line: string) => void;
  private stopped = false;

  constructor(opts: PreviewListenerOptions) {
    this.opts = opts;
    this.token = randomBytes(32).toString("base64url");
    this.waitMs = opts.waitMs ?? PREVIEW_API_WAIT_MS;
    this.onLog = opts.onLog ?? (() => {});
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => { void this.handle(req, res); });
    server.requestTimeout = this.waitMs + 60_000;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === "string" || !loopbackAddress(address.address)) {
      await this.stop();
      throw new Error("preview listener must bind 127.0.0.1");
    }
    this.port = address.port;
  }

  list(): PreviewInfo[] {
    return [...this.open.values()].map((o) => ({ ...o.info }));
  }

  /** A `preview.result` down-frame. Unknown or late ids are ignored. */
  deliver(frame: PreviewResultFrame): void {
    if (!frame || frame.t !== "preview.result" || typeof frame.requestId !== "string") return;
    const waiter = this.waiters.get(frame.requestId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(frame.requestId);
    waiter.resolve(frame);
  }

  /** Closes one preview: tunnel, proxy, and a `preview.close` up. Idempotent. */
  async close(port: number): Promise<void> {
    const o = this.open.get(port);
    if (!o) return;
    this.open.delete(port);
    await Promise.allSettled([o.tunnel.stop(), o.proxy.stop()]);
    this.sendSafe({ t: "preview.close", port });
  }

  /** Run end: closes every preview and the listener. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const [id, w] of this.waiters) {
      clearTimeout(w.timer);
      this.waiters.delete(id);
      w.resolve({ t: "preview.result", requestId: id, error: "timeout" });
    }
    await Promise.allSettled([...this.opening.values()]);
    await Promise.allSettled([...this.open.keys()].map((p) => this.close(p)));
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  private sendSafe(frame: UpPreviewOpen | UpPreviewClose): void {
    try { this.opts.send(frame); } catch (err) { this.onLog(`preview frame ${frame.t} failed: ${(err as Error).message}`); }
  }

  private portAllowed(port: number): boolean {
    if (port < 1024 || port > 65535) return false;
    if (port === this.port) return false;
    for (const o of this.open.values()) if (o.proxy.port === port) return false;
    return !(this.opts.reservedPorts?.() ?? []).includes(port);
  }

  private async openPreview(req: { port: number; jobId?: string; share: boolean }): Promise<PreviewInfo> {
    const existing = this.open.get(req.port);
    if (existing) return { ...existing.info };
    const pending = this.opening.get(req.port);
    if (pending) return pending;
    const p = this.doOpen(req).finally(() => this.opening.delete(req.port));
    this.opening.set(req.port, p);
    return p;
  }

  private async doOpen(req: { port: number; jobId?: string; share: boolean }): Promise<PreviewInfo> {
    if (!(await probePort(req.port))) throw new PreviewFailure("nothing-listening", `nothing is listening on port ${req.port} yet; start the server first (background run) and check its log`);
    const proxy = new LocalPreviewProxy({ port: req.port, onActivity: this.opts.onActivity, onLog: this.onLog });
    await proxy.start();
    const internalUrl = `https://p${req.port}.${this.opts.internalDomain}`;
    let tunnel: NgrokTunnel;
    try {
      const start: StartTunnel = this.opts.startTunnel
        ?? ((o) => startNgrok({ ...o, bin: this.opts.ngrokBin, onLog: this.onLog }));
      tunnel = await start({
        upstream: `http://127.0.0.1:${proxy.port}`,
        url: internalUrl,
        authtoken: this.opts.authtoken,
        onExit: (reason) => {
          this.onLog(`preview ${req.port}: ${reason}`);
          void this.close(req.port);
        },
      });
    } catch (err) {
      await proxy.stop();
      if (err instanceof NgrokStartError) throw new PreviewFailure(err.kind, err.message);
      throw new PreviewFailure("failed", (err as Error).message);
    }
    const requestId = randomUUID();
    const pending = this.expect(requestId);
    this.sendSafe({ t: "preview.open", requestId, port: req.port, internalUrl, share: req.share });
    const result = await pending;
    if (result.error || !result.url || this.stopped) {
      await Promise.allSettled([tunnel.stop(), proxy.stop()]);
      this.sendSafe({ t: "preview.close", port: req.port });
      const code: PreviewError = result.error === "not-configured" ? "not-configured" : result.error === "timeout" ? "timeout" : "failed";
      throw new PreviewFailure(code, result.error === "timeout" ? "the api did not create the public URL in time" : `the api could not create the public URL: ${result.error ?? "no url"}`);
    }
    const info: PreviewInfo = {
      port: req.port, url: result.url,
      ...(req.jobId ? { jobId: req.jobId } : {}),
      ...(req.share ? { share: true } : {}),
      ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
    };
    this.open.set(req.port, { info, proxy, tunnel });
    return { ...info };
  }

  private expect(requestId: string): Promise<PreviewResultFrame> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        resolve({ t: "preview.result", requestId, error: "timeout" });
      }, this.waitMs);
      timer.unref?.();
      this.waiters.set(requestId, { resolve, timer });
    });
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", connection: "close" });
    res.end(JSON.stringify(body));
  }

  private fail(res: ServerResponse, error: keyof typeof STATUS, detail: string): void {
    this.json(res, STATUS[error], { error, detail });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!loopbackAddress(req.socket.remoteAddress)) return this.fail(res, "forbidden", "loopback only");
      if (!tokenMatches(headerValue(req, PREVIEW_TOKEN_HEADER), this.token)) return this.fail(res, "forbidden", "bad token");
      if (!(await this.peerAllowed(req))) return this.fail(res, "forbidden", "wrong peer");
      const path = (req.url ?? "").split("?")[0] ?? "";
      if (req.method === "GET" && path === "/previews") return this.json(res, 200, { previews: this.list() });
      if (req.method === "POST" && path === "/ide") {
        const outcome = this.opts.onIdeRequest?.();
        if (!outcome) return this.fail(res, "not_found", "this Drive has no IDE");
        if ("error" in outcome) return this.json(res, outcome.error === "too-many" ? 429 : 503, outcome);
        return this.json(res, 202, { requested: true });
      }
      const del = /^\/previews\/(\d{1,5})$/.exec(path);
      if (req.method === "DELETE" && del) {
        await this.close(Number(del[1]));
        return this.json(res, 200, { closed: true });
      }
      if (req.method !== "POST" || path !== "/previews") return this.fail(res, "not_found", `${req.method} ${path}`);
      let body: unknown;
      try { body = await readJson(req); } catch { return this.fail(res, "rejected", "body too large"); }
      const parsed = parsePreviewRequest(body);
      if (!parsed) return this.fail(res, "rejected", "expected {port: integer, jobId?: string, share?: boolean}");
      if (!this.portAllowed(parsed.port)) return this.fail(res, "port-not-allowed", `port ${parsed.port} can't be previewed (use 1024-65535, not one of agentd's own ports)`);
      if (this.stopped) return this.fail(res, "failed", "the run is stopping");
      try {
        const info = await this.openPreview(parsed);
        return this.json(res, 200, { url: info.url, port: info.port, ...(info.expiresAt ? { expiresAt: info.expiresAt } : {}) });
      } catch (err) {
        if (err instanceof PreviewFailure) return this.fail(res, err.code, err.message);
        throw err;
      }
    } catch (err) {
      this.onLog(`preview request failed: ${err instanceof Error ? err.message : String(err)}`);
      this.fail(res, "failed", "internal error");
    }
  }

  private async peerAllowed(req: IncomingMessage): Promise<boolean> {
    if (this.opts.peerUid === undefined) return true;
    const localPort = req.socket.localPort;
    const remotePort = req.socket.remotePort;
    if (localPort === undefined || remotePort === undefined) return false;
    let table: string;
    try {
      table = await readFile("/proc/net/tcp", "utf8");
    } catch (err: any) {
      this.onLog(`preview peer check unavailable: ${err?.code ?? err?.message ?? err}`);
      return false;
    }
    return peerUidFromProcNet(table, localPort, remotePort) === this.opts.peerUid;
  }
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
