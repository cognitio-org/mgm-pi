/**
 * Loopback side of the Drive `browser_inspect` tool. Sibling of the action listener.
 * One HTTP call is one tool call. This process mints `requestId`, sends
 * `browser.inspect.request`, and waits up to 90s for `browser.inspect.result`.
 * It does not attach a debugger and it does not see OUTFITTER_TOKEN.
 * Cookie and Authorization header values are stripped before the tool sees the body.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { peerUidFromProcNet } from "./browser-capture.js";

/** How long agentd waits for the owner to allow DevTools and the extension to read. */
export const BROWSER_INSPECT_WAIT_MS = 90_000;

export const BROWSER_INSPECT_TOKEN_HEADER = "x-outfitter-browser-token";

const BODY_MAX = 64_000;
const MESSAGE_LIMIT = 40;
const TEXT_MAX = 500;
const ELEMENT_DESCRIPTION = /^[a-z][a-z0-9-]*(?:#[A-Za-z_][A-Za-z0-9_-]{0,63})?(?:\.[A-Za-z_][A-Za-z0-9_-]{0,63}){0,8}$/;

export interface BrowserInspectResultFrame {
  t: "browser.inspect.result";
  requestId: string;
  messages?: string[];
  element?: string | null;
  error?: string;
}

export type InspectOutcome =
  | { messages: string[]; element: string | null }
  | { error: string };

export interface InspectListenerOptions {
  sendRequest: (requestId: string) => void;
  peerUid?: number;
  waitMs?: number;
  onLog?: (line: string) => void;
}

interface Waiter {
  resolve: (frame: BrowserInspectResultFrame) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function redactHeaderText(text: string): string {
  return text.replace(
    /\b(authorization|proxy-authorization|cookie|set-cookie)\b\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]+)/gi,
    "$1: [redacted]",
  );
}

/** The body the loopback returns. Header values are gone. There is no headers field. */
export function publicInspect(frame: BrowserInspectResultFrame): InspectOutcome {
  if (typeof frame.error === "string" && frame.error.length > 0) return { error: redactHeaderText(frame.error) };
  const messages: string[] = [];
  if (Array.isArray(frame.messages)) {
    for (const line of frame.messages) {
      if (typeof line !== "string") continue;
      const text = redactHeaderText(line).replace(/\u0000/g, "").trim().slice(0, TEXT_MAX);
      if (!text) continue;
      messages.push(text);
      if (messages.length >= MESSAGE_LIMIT) break;
    }
  }
  const element = typeof frame.element === "string" && ELEMENT_DESCRIPTION.test(frame.element.trim())
    ? frame.element.trim()
    : null;
  return { messages, element };
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

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_MAX) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}

function emptyBody(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body !== "object" || Array.isArray(body)) return false;
  return Object.keys(body).length === 0;
}

export class InspectListener {
  readonly token: string;
  port: number | undefined;
  private server: Server | undefined;
  private readonly waiters = new Map<string, Waiter>();
  private readonly waitMs: number;
  private readonly onLog: (line: string) => void;
  private readonly opts: InspectListenerOptions;

  constructor(opts: InspectListenerOptions) {
    this.opts = opts;
    this.token = randomBytes(32).toString("base64url");
    this.waitMs = opts.waitMs ?? BROWSER_INSPECT_WAIT_MS;
    this.onLog = opts.onLog ?? (() => {});
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => {
      void this.handle(req, res);
    });
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
      throw new Error("browser inspect listener must bind 127.0.0.1");
    }
    this.port = address.port;
  }

  async stop(): Promise<void> {
    for (const [id, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      this.waiters.delete(id);
      waiter.resolve({ t: "browser.inspect.result", requestId: id, error: "timeout" });
    }
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  deliver(frame: BrowserInspectResultFrame): void {
    if (!frame || frame.t !== "browser.inspect.result" || typeof frame.requestId !== "string") return;
    const waiter = this.waiters.get(frame.requestId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(frame.requestId);
    waiter.resolve(frame);
  }

  private expect(requestId: string): Promise<BrowserInspectResultFrame> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        resolve({ t: "browser.inspect.result", requestId, error: "timeout" });
      }, this.waitMs);
      timer.unref?.();
      this.waiters.set(requestId, { resolve, timer });
    });
  }

  private refuse(res: ServerResponse): void {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8", connection: "close" });
    res.end(JSON.stringify({ error: "forbidden" }));
  }

  private reply(res: ServerResponse, outcome: InspectOutcome): void {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", connection: "close" });
    res.end(JSON.stringify(outcome));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!loopbackAddress(req.socket.remoteAddress)) {
        this.refuse(res);
        return;
      }
      const path = (req.url ?? "").split("?")[0];
      if (req.method !== "POST" || path !== "/browser/inspect") {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8", connection: "close" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      if (!tokenMatches(headerValue(req, BROWSER_INSPECT_TOKEN_HEADER), this.token)) {
        this.refuse(res);
        return;
      }
      if (!(await this.peerAllowed(req))) {
        this.refuse(res);
        return;
      }
      const body = await readJson(req);
      if (!emptyBody(body)) {
        this.reply(res, { error: "rejected" });
        return;
      }
      const requestId = randomUUID();
      const pending = this.expect(requestId);
      try {
        this.opts.sendRequest(requestId);
      } catch (err) {
        this.onLog(`browser inspect request failed: ${err instanceof Error ? err.message : String(err)}`);
        this.deliver({ t: "browser.inspect.result", requestId, error: "timeout" });
      }
      const frame = await pending;
      this.reply(res, publicInspect(frame));
    } catch (err) {
      this.onLog(`browser inspect failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) this.reply(res, { error: "timeout" });
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
      this.onLog(`browser inspect peer check unavailable: ${err?.code ?? err?.message ?? err}`);
      return false;
    }
    return peerUidFromProcNet(table, localPort, remotePort) === this.opts.peerUid;
  }
}
