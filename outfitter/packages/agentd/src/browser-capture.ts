/**
 * Loopback side of the Drive `browser_capture` tool (docs/specs/chrome-companion.md §13).
 *
 * The pi extension runs as the unprivileged `agent` user and must not hold the API credential,
 * so it only talks to this process. agentd binds `127.0.0.1` (never `0.0.0.0`) while the
 * extension is loaded. Loopback is still reachable by every account on the machine, so a request
 * also has to present the per-run secret that is given only to the pi process, and — when a peer
 * uid is configured — the connecting process on Linux has to be that uid. Either check failing
 * closes the request before a capture is asked for.
 *
 * One HTTP call is one tool call: this process mints `requestId` once, sends
 * `browser.capture.request`, and waits up to 90s for `browser.capture.result`.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { chmod, chown, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** How long agentd waits for the extension to upload or the owner to revoke. */
export const BROWSER_CAPTURE_WAIT_MS = 90_000;

/** Same byte cap as the api's capture route. A larger download is `too_large` and is not written. */
export const BROWSER_CAPTURE_MAX_BYTES = 350_000;

/** Errors the tool shows the model as text. `timeout` is this wait expiring; the others arrive
 * on `browser.capture.result`. */
export const BROWSER_CAPTURE_ERRORS = [
  "no_share",
  "skipped",
  "timeout",
  "permission_denied",
  "tab_gone",
  "too_large",
] as const;

export type BrowserCaptureError = (typeof BROWSER_CAPTURE_ERRORS)[number];

/** Header the pi extension sends. Not a user Dongle and not the run token. */
export const BROWSER_CAPTURE_TOKEN_HEADER = "x-outfitter-browser-token";

export interface BrowserCaptureResultFrame {
  t: "browser.capture.result";
  requestId: string;
  captureId?: string;
  title?: string;
  url?: string;
  error?: string;
}

export interface CaptureDownloadError extends Error {
  captureError: string;
}

export function captureDownloadError(captureError: string): CaptureDownloadError {
  const err = new Error(captureError) as CaptureDownloadError;
  err.captureError = captureError;
  return err;
}

export function isCaptureDownloadError(err: unknown): err is CaptureDownloadError {
  return err instanceof Error && typeof (err as CaptureDownloadError).captureError === "string";
}

/** Success the tool can read, or one of the text errors. */
export type CaptureOutcome =
  | { error: string }
  | { title: string; url: string; path: string };

export interface CaptureListenerOptions {
  workspace: string;
  /** Download the jpeg with the run's existing API credential. agentd does this, not the tool. */
  download: (captureId: string) => Promise<Buffer>;
  /** Up-frame on the API socket. Called once per tool call, after the waiter is registered. */
  sendRequest: (requestId: string) => void;
  /** When set, a Linux peer whose uid is not this value is refused. No `/proc` means refuse too:
   * the check was asked for and cannot be made. Unset skips the check (tests, non-root dev). */
  peerUid?: number;
  /** chown of the capture directory and file so the `agent` user can read a root-written jpeg. */
  chownTo?: { uid: number; gid: number };
  /** Defaults to 90s. Tests pass a short wait. */
  waitMs?: number;
  onLog?: (line: string) => void;
}

interface Waiter {
  resolve: (frame: BrowserCaptureResultFrame) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * uid of the process that owns the client side of a loopback TCP connection, from `/proc/net/tcp`.
 * `localPort` is this server's port; `remotePort` is the client's. The server's own row is the
 * other direction and is ignored. Returns undefined when the peer isn't in the table.
 */
export function peerUidFromProcNet(table: string, localPort: number, remotePort: number): number | undefined {
  for (const line of table.split("\n")) {
    const parts = line.trim().split(/\s+/);
    // sl, local, rem, st, tx:rx, tr:tm, retrnsmt, uid, ...
    if (parts.length < 8) continue;
    const local = splitEndpoint(parts[1]);
    const remote = splitEndpoint(parts[2]);
    if (!local || !remote) continue;
    // The client's socket: its local port is the port we see as remote.
    if (local.port !== remotePort || remote.port !== localPort) continue;
    if (local.addr !== "0100007F" || remote.addr !== "0100007F") continue;
    const uid = Number(parts[7]);
    if (!Number.isInteger(uid) || uid < 0) continue;
    return uid;
  }
  return undefined;
}

function splitEndpoint(endpoint: string | undefined): { addr: string; port: number } | undefined {
  if (!endpoint) return undefined;
  const idx = endpoint.lastIndexOf(":");
  if (idx <= 0) return undefined;
  const port = Number.parseInt(endpoint.slice(idx + 1), 16);
  if (!Number.isInteger(port) || port < 0) return undefined;
  return { addr: endpoint.slice(0, idx).toUpperCase(), port };
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

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function loopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

/** `/workspace/.outfitter/captures/<captureId>.jpg` — captureId is the api's id, never a path. */
export function captureFilePath(workspace: string, captureId: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(captureId)) return undefined;
  return join(workspace, ".outfitter", "captures", `${captureId}.jpg`);
}

export class CaptureListener {
  readonly token: string;
  port: number | undefined;
  private server: Server | undefined;
  private readonly waiters = new Map<string, Waiter>();
  private readonly waitMs: number;
  private readonly onLog: (line: string) => void;
  private readonly opts: CaptureListenerOptions;

  constructor(opts: CaptureListenerOptions) {
    this.opts = opts;
    this.token = randomBytes(32).toString("base64url");
    this.waitMs = opts.waitMs ?? BROWSER_CAPTURE_WAIT_MS;
    this.onLog = opts.onLog ?? (() => {});
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
    // The handler waits out the capture. Node's default request timeout is 5 minutes, which
    // covers 90s; a test with a short wait still has to outlive that wait.
    server.requestTimeout = this.waitMs + 15_000;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string" || !loopbackAddress(address.address)) {
      await this.stop();
      throw new Error("browser capture listener must bind 127.0.0.1");
    }
    this.port = address.port;
  }

  /** Idempotent. In-flight tool calls resolve as `timeout` so the HTTP handler can finish. */
  async stop(): Promise<void> {
    for (const [id, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      this.waiters.delete(id);
      waiter.resolve({ t: "browser.capture.result", requestId: id, error: "timeout" });
    }
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** A `browser.capture.result` down-frame. Unknown or late ids are ignored. */
  deliver(frame: BrowserCaptureResultFrame): void {
    if (!frame || frame.t !== "browser.capture.result" || typeof frame.requestId !== "string") return;
    const waiter = this.waiters.get(frame.requestId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(frame.requestId);
    waiter.resolve(frame);
  }

  private expect(requestId: string): Promise<BrowserCaptureResultFrame> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        resolve({ t: "browser.capture.result", requestId, error: "timeout" });
      }, this.waitMs);
      timer.unref?.();
      this.waiters.set(requestId, { resolve, timer });
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!loopbackAddress(req.socket.remoteAddress)) {
        this.refuse(res);
        return;
      }
      const path = (req.url ?? "").split("?")[0];
      if (req.method !== "GET" || path !== "/browser/capture") {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8", connection: "close" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      if (!tokenMatches(headerValue(req, BROWSER_CAPTURE_TOKEN_HEADER), this.token)) {
        this.refuse(res);
        return;
      }
      if (!(await this.peerAllowed(req))) {
        this.refuse(res);
        return;
      }
      const requestId = randomUUID();
      const pending = this.expect(requestId);
      try {
        this.opts.sendRequest(requestId);
      } catch (err) {
        this.onLog(`browser capture request failed: ${err instanceof Error ? err.message : String(err)}`);
        this.deliver({ t: "browser.capture.result", requestId, error: "timeout" });
      }
      const frame = await pending;
      const outcome = await this.outcomeFor(frame);
      this.reply(res, outcome);
    } catch (err) {
      this.onLog(`browser capture failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) this.reply(res, { error: "timeout" });
    }
  }

  /** Token already matched. `true` when no peer uid was configured, or the Linux peer is that uid. */
  private async peerAllowed(req: IncomingMessage): Promise<boolean> {
    if (this.opts.peerUid === undefined) return true;
    const localPort = req.socket.localPort;
    const remotePort = req.socket.remotePort;
    if (localPort === undefined || remotePort === undefined) return false;
    let table: string;
    try {
      table = await readFile("/proc/net/tcp", "utf8");
    } catch (err: any) {
      // Asked to check the peer and can't. Don't fall open onto the token alone.
      this.onLog(`browser capture peer check unavailable: ${err?.code ?? err?.message ?? err}`);
      return false;
    }
    return peerUidFromProcNet(table, localPort, remotePort) === this.opts.peerUid;
  }

  private async outcomeFor(frame: BrowserCaptureResultFrame): Promise<CaptureOutcome> {
    if (typeof frame.error === "string" && frame.error.length > 0) return { error: frame.error };
    if (typeof frame.captureId !== "string" || typeof frame.title !== "string" || typeof frame.url !== "string") {
      return { error: "timeout" };
    }
    const path = captureFilePath(this.opts.workspace, frame.captureId);
    if (!path) return { error: "timeout" };
    let bytes: Buffer;
    try {
      bytes = await this.opts.download(frame.captureId);
    } catch (err) {
      if (isCaptureDownloadError(err)) return { error: err.captureError };
      this.onLog(`browser capture download failed: ${err instanceof Error ? err.message : String(err)}`);
      return { error: "timeout" };
    }
    if (bytes.length === 0 || bytes.length > BROWSER_CAPTURE_MAX_BYTES) return { error: "too_large" };
    const dir = join(this.opts.workspace, ".outfitter", "captures");
    const parent = join(this.opts.workspace, ".outfitter");
    await mkdir(dir, { recursive: true });
    await chmod(parent, 0o700);
    await chmod(dir, 0o700);
    await writeFile(path, bytes, { mode: 0o600, flag: "w" });
    await chmod(path, 0o600);
    if (this.opts.chownTo) {
      try {
        await chown(parent, this.opts.chownTo.uid, this.opts.chownTo.gid);
        await chown(dir, this.opts.chownTo.uid, this.opts.chownTo.gid);
        await chown(path, this.opts.chownTo.uid, this.opts.chownTo.gid);
      } catch (err: any) {
        // Outside the image agentd isn't root. The file is still mode 0600 owned by this user.
        this.onLog(`browser capture chown skipped: ${err?.message ?? err}`);
      }
    }
    return { title: frame.title, url: frame.url, path };
  }

  private refuse(res: ServerResponse): void {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8", connection: "close" });
    res.end(JSON.stringify({ error: "forbidden" }));
  }

  private reply(res: ServerResponse, outcome: CaptureOutcome): void {
    if (res.headersSent) return;
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      connection: "close",
    });
    res.end(JSON.stringify(outcome));
  }
}
