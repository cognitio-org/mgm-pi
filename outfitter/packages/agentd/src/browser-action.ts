/**
 * Loopback side of the Drive `browser_action` tool. Sibling of the capture listener
 * (browser-capture.ts): its own port, its own token, the same loopback and peer checks.
 * One HTTP call is one tool call. This process mints `requestId`, sends
 * `browser.action.request`, and waits up to 90s for `browser.action.result`.
 * It does not download anything and it does not see OUTFITTER_TOKEN.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { peerUidFromProcNet } from "./browser-capture.js";

/** How long agentd waits for the owner to allow the action and the extension to run it. */
export const BROWSER_ACTION_WAIT_MS = 90_000;

/** Header the pi extension sends. Same name as capture, a different token. */
export const BROWSER_ACTION_TOKEN_HEADER = "x-outfitter-browser-token";

const SELECTOR_MAX = 500;
const TEXT_MAX = 8000;
const BODY_MAX = 16_000;

export interface BrowserActionResultFrame {
  t: "browser.action.result";
  requestId: string;
  error?: string;
}

export interface ActionRequest {
  requestId: string;
  kind: "click" | "type";
  selector: string;
  text?: string;
}

export type ActionOutcome = { ok: true } | { error: string };

export interface ActionListenerOptions {
  sendRequest: (action: ActionRequest) => void;
  /** When set, a Linux peer whose uid is not this value is refused. */
  peerUid?: number;
  waitMs?: number;
  onLog?: (line: string) => void;
}

interface Waiter {
  resolve: (frame: BrowserActionResultFrame) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function selectorOk(selector: string): boolean {
  if (selector.length === 0 || selector.length > SELECTOR_MAX) return false;
  if (/[\u0000-\u001f\u007f<{}`;]/.test(selector)) return false;
  if (/javascript\s*:/i.test(selector)) return false;
  if (/eval\s*\(/i.test(selector) || /function\s*\(/i.test(selector)) return false;
  if (selector.includes("=>")) return false;
  if (/url\s*\(/i.test(selector) || /expression\s*\(/i.test(selector)) return false;
  return true;
}

/** The body the tool posts. Raw JavaScript is not an action. */
export function parseActionRequest(body: unknown): { kind: "click" | "type"; selector: string; text?: string } | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.kind !== "click" && record.kind !== "type") return undefined;
  if (typeof record.selector !== "string" || !selectorOk(record.selector.trim())) return undefined;
  const selector = record.selector.trim();
  if (record.kind === "click") {
    if (keys.some((key) => key !== "kind" && key !== "selector")) return undefined;
    return { kind: "click", selector };
  }
  if (!keys.every((key) => key === "kind" || key === "selector" || key === "text")) return undefined;
  if (typeof record.text !== "string" || record.text.length > TEXT_MAX || record.text.includes("\u0000")) return undefined;
  return { kind: "type", selector, text: record.text };
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
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        resolve(undefined);
      }
    });
    req.on("error", reject);
  });
}

export class ActionListener {
  readonly token: string;
  port: number | undefined;
  private server: Server | undefined;
  private readonly waiters = new Map<string, Waiter>();
  private readonly waitMs: number;
  private readonly onLog: (line: string) => void;
  private readonly opts: ActionListenerOptions;

  constructor(opts: ActionListenerOptions) {
    this.opts = opts;
    this.token = randomBytes(32).toString("base64url");
    this.waitMs = opts.waitMs ?? BROWSER_ACTION_WAIT_MS;
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
      throw new Error("browser action listener must bind 127.0.0.1");
    }
    this.port = address.port;
  }

  /** Idempotent. In-flight tool calls resolve as `timeout`. */
  async stop(): Promise<void> {
    for (const [id, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      this.waiters.delete(id);
      waiter.resolve({ t: "browser.action.result", requestId: id, error: "timeout" });
    }
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** A `browser.action.result` down-frame. Unknown or late ids are ignored. */
  deliver(frame: BrowserActionResultFrame): void {
    if (!frame || frame.t !== "browser.action.result" || typeof frame.requestId !== "string") return;
    const waiter = this.waiters.get(frame.requestId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(frame.requestId);
    waiter.resolve(frame);
  }

  private expect(requestId: string): Promise<BrowserActionResultFrame> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        resolve({ t: "browser.action.result", requestId, error: "timeout" });
      }, this.waitMs);
      timer.unref?.();
      this.waiters.set(requestId, { resolve, timer });
    });
  }

  private refuse(res: ServerResponse): void {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8", connection: "close" });
    res.end(JSON.stringify({ error: "forbidden" }));
  }

  private reply(res: ServerResponse, outcome: ActionOutcome): void {
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
      if (req.method !== "POST" || path !== "/browser/action") {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8", connection: "close" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      if (!tokenMatches(headerValue(req, BROWSER_ACTION_TOKEN_HEADER), this.token)) {
        this.refuse(res);
        return;
      }
      if (!(await this.peerAllowed(req))) {
        this.refuse(res);
        return;
      }
      const parsed = parseActionRequest(await readJson(req));
      if (!parsed) {
        this.reply(res, { error: "rejected" });
        return;
      }
      const requestId = randomUUID();
      const pending = this.expect(requestId);
      try {
        this.opts.sendRequest({ requestId, ...parsed });
      } catch (err) {
        this.onLog(`browser action request failed: ${err instanceof Error ? err.message : String(err)}`);
        this.deliver({ t: "browser.action.result", requestId, error: "timeout" });
      }
      const frame = await pending;
      if (typeof frame.error === "string" && frame.error.length > 0) this.reply(res, { error: frame.error });
      else this.reply(res, { ok: true });
    } catch (err) {
      this.onLog(`browser action failed: ${err instanceof Error ? err.message : String(err)}`);
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
      this.onLog(`browser action peer check unavailable: ${err?.code ?? err?.message ?? err}`);
      return false;
    }
    return peerUidFromProcNet(table, localPort, remotePort) === this.opts.peerUid;
  }
}
