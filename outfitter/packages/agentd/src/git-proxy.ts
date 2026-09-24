/**
 * Localhost git smart-HTTP proxy (kernal/docs/git-github-spec.md, "Git proxy").
 *
 * pi's own git talks to 127.0.0.1. The GitHub token is added only on the upstream
 * request and is never copied into a response, a log line, or pi's environment.
 * Callers pin `url.<proxy>.insteadOf` through gitProxyInsteadOfEnv — not
 * `http.extraheader`, and not by widening baseEnvForPi's allowlist (that hole
 * is how the token leaked before).
 *
 * A receive-pack is refused in full, before anything is forwarded, when the
 * command section is not a list of standalone ref-update pkt-lines, or when any
 * update is a deletion or names a ref outside the caller's allow-list.
 * Force-updates of an allowed ref are updates, not deletions, so they pass.
 * A flush with no commands is not a command, and is forwarded.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable, Transform } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authHeaderSecret, gitConfigEnv } from "./git.js";
import type { AsyncLock } from "./lock.js";

const MAX_COMMAND_SECTION = 1024 * 1024;
const REDACTED = Buffer.from("[redacted]");

export interface GitProxy {
  /** `http://127.0.0.1:<port>/<owner>/<repo>.git` — no token in it. */
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface GitProxyOptions {
  owner: string;
  repo: string;
  token: string;
  /** Ref names the client may update. A name without `refs/` means `refs/heads/<name>`. */
  allowedRefs: readonly string[];
  /** Origin only, no path. Default `https://github.com`. Tests point this at a fake. */
  upstreamBase?: string;
  log?: (line: string) => void;
  /** Held for each upstream forward so a phase-0 checkpoint push cannot overlap a fetch or push. */
  lock?: AsyncLock;
}

const NAME = /^[A-Za-z0-9_.-]+$/;

/** `https://github.com/owner/repo.git` (optional `.git`). Anything else is not this proxy's remote. */
export function parseGithubCloneUrl(raw: string): { owner: string; repo: string } | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.host !== "github.com") return undefined;
  if (url.username || url.password) return undefined;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return undefined;
  const owner = parts[0]!;
  let repo = parts[1]!;
  if (repo.endsWith(".git")) repo = repo.slice(0, -".git".length);
  if (!safeName(owner) || !safeName(repo)) return undefined;
  return { owner, repo };
}

function safeName(name: string): boolean {
  return NAME.test(name) && name !== "." && name !== ".." && !name.includes("..");
}

/** The only git config pi should see for this proxy: rewrite the public GitHub URL to localhost. */
export function gitProxyInsteadOfEnv(proxyRepoUrl: string, githubRepoUrl: string): Record<string, string> {
  return gitConfigEnv([[`url.${proxyRepoUrl}.insteadOf`, githubRepoUrl]]);
}

export function githubRepoHttps(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

interface RefUpdate {
  oldOid: string;
  newOid: string;
  ref: string;
  capabilities: string;
}

export async function startGitProxy(opts: GitProxyOptions): Promise<GitProxy> {
  if (!safeName(opts.owner) || !safeName(opts.repo)) {
    throw new Error("git proxy: owner and repo must be a single GitHub path segment");
  }
  if (!opts.token || /[\r\n\0]/.test(opts.token)) {
    throw new Error("git proxy: refusing an empty or malformed token");
  }
  const allowed = normalizeAllowed(opts.allowedRefs);
  const upstreamBase = (opts.upstreamBase ?? "https://github.com").replace(/\/$/, "");
  const needles = secretNeedles(opts.token);
  const log = (line: string) => {
    try {
      opts.log?.(scrubText(line, needles));
    } catch {
      // a log sink must not take the run down, and must not be given the token to retry with
    }
  };

  const sockets = new Set<net.Socket>();
  const server = http.createServer((req, res) => {
    void handle(req, res, {
      owner: opts.owner,
      repo: opts.repo,
      token: opts.token,
      allowed,
      upstreamBase,
      needles,
      log,
      lock: opts.lock,
    }).catch((err: unknown) => {
      log(`git proxy: request failed (${errName(err)})`);
      if (!res.headersSent) sendText(res, 500, "git proxy: internal error\n");
      else res.destroy();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_err, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  server.on("error", (err) => log(`git proxy: ${errName(err)}`));

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("git proxy: failed to bind 127.0.0.1");
  }
  const url = `http://127.0.0.1:${addr.port}/${opts.owner}/${opts.repo}.git`;
  log(`git proxy listening on ${url}`);

  let closed = false;
  return {
    url,
    port: addr.port,
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      for (const socket of sockets) socket.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function normalizeAllowed(refs: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const ref of refs) {
    if (typeof ref !== "string" || ref.length === 0 || /[\s\0]/.test(ref)) continue;
    out.add(ref.startsWith("refs/") ? ref : `refs/heads/${ref}`);
  }
  return out;
}

interface HandleCtx {
  owner: string;
  repo: string;
  token: string;
  allowed: Set<string>;
  upstreamBase: string;
  needles: Buffer[];
  log: (line: string) => void;
  lock?: AsyncLock;
}

async function handle(req: IncomingMessage, res: ServerResponse, ctx: HandleCtx): Promise<void> {
  // Stays after ByteReader detaches, so a client abort cannot surface as an unhandled 'error'.
  req.on("error", () => {
    if (!res.headersSent) res.destroy();
  });
  const route = routeOf(req.url ?? "/", ctx.owner, ctx.repo);
  if (route === "bad" || route === "other") {
    ctx.log(`git proxy ${req.method ?? "?"} rejected`);
    sendText(res, 404, "not found\n");
    return;
  }
  if (route.kind === "info") {
    if (req.method !== "GET") {
      sendText(res, 405, "method not allowed\n");
      return;
    }
    const service = serviceOf(route.search);
    if (!service) {
      ctx.log("git proxy info/refs rejected");
      sendText(res, 404, "not found\n");
      return;
    }
    const upstream = upstreamUrl(ctx, "/info/refs", `?service=${service}`);
    await underLock(ctx, () => forward(req, res, upstream, ctx, undefined));
    return;
  }
  if (req.method !== "POST" || route.search !== "") {
    sendText(res, route.search ? 404 : 405, route.search ? "not found\n" : "method not allowed\n");
    return;
  }
  const suffix = route.kind === "upload" ? "/git-upload-pack" : "/git-receive-pack";
  if (route.kind === "upload") {
    await underLock(ctx, () => forward(req, res, upstreamUrl(ctx, suffix, ""), ctx, req));
    return;
  }
  await handleReceivePack(req, res, ctx, upstreamUrl(ctx, suffix, ""));
}

function underLock(ctx: HandleCtx, fn: () => Promise<void>): Promise<void> {
  return ctx.lock ? ctx.lock(fn) : fn();
}

function upstreamUrl(ctx: HandleCtx, suffix: string, search: string): string {
  return `${ctx.upstreamBase}/${ctx.owner}/${ctx.repo}.git${suffix}${search}`;
}

async function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandleCtx,
  upstream: string,
): Promise<void> {
  const reader = new ByteReader(req);
  let section: CommandSection;
  try {
    section = await readCommandSection(reader);
  } catch (err) {
    await reader.drain();
    ctx.log(`git proxy receive-pack rejected (${errName(err)})`);
    // Modern git asks for side-band-64k; a plain pkt-line is "bad band" and hides the reason.
    writeRefusal(res, "refusing push: malformed receive-pack request\n", true);
    return;
  }
  if (section.updates) {
    const reasons = refusalReasons(section.updates, ctx.allowed);
    if (reasons.length > 0) {
      await reader.drain();
      ctx.log("git proxy receive-pack refused by ref policy");
      // The ref name came from the client; scrub so a ref that embeds the token is not echoed.
      const message = scrubText(`refusing push: ${reasons.join("; ")}\n`, ctx.needles);
      writeRefusal(res, message, clientWantsSideband(section.updates));
      return;
    }
  }
  const body = reader.restPrefixed(section.raw);
  await underLock(ctx, () => forward(req, res, upstream, ctx, body));
}

function refusalReasons(updates: RefUpdate[], allowed: Set<string>): string[] {
  const reasons: string[] = [];
  for (const update of updates) {
    if (isZeroOid(update.newOid)) reasons.push(`refusing to delete ${safeRef(update.ref)}`);
    else if (!allowed.has(update.ref)) reasons.push(`${safeRef(update.ref)} is not an allowed ref`);
  }
  return reasons;
}

function safeRef(ref: string): string {
  return ref.replace(/[^\x20-\x7e]/g, "?");
}

function isZeroOid(oid: string): boolean {
  return /^0+$/.test(oid);
}

function clientWantsSideband(updates: RefUpdate[]): boolean {
  const caps = updates.map((update) => update.capabilities).join(" ");
  return /(^|\s)side-band-64k(\s|$)/.test(caps) || /(^|\s)side-band(\s|$)/.test(caps);
}

/** report-status `unpack` line, sideband-wrapped when the client negotiated it. Git prints it. */
function writeRefusal(res: ServerResponse, message: string, sideband: boolean): void {
  const line = message.endsWith("\n") ? message : `${message}\n`;
  const inner = Buffer.concat([pkt(`unpack ${line}`), Buffer.from("0000")]);
  const body = sideband
    ? Buffer.concat([pkt(Buffer.concat([Buffer.from([1]), inner])), Buffer.from("0000")])
    : inner;
  res.writeHead(200, {
    "content-type": "application/x-git-receive-pack-result",
    "cache-control": "no-cache",
    "content-length": body.length,
  });
  res.end(body);
}

interface CommandSection {
  raw: Buffer;
  /** Ref updates before the first flush, or null when this is not a ref-update command (forward it). */
  updates: RefUpdate[] | null;
}

async function readCommandSection(reader: ByteReader): Promise<CommandSection> {
  const parts: Buffer[] = [];
  const payloads: Buffer[] = [];
  let total = 0;
  while (total <= MAX_COMMAND_SECTION) {
    const lenBuf = await reader.read(4);
    if (lenBuf.length < 4) throw new Error("truncated pkt-line");
    const hex = lenBuf.toString("ascii");
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error("bad pkt-line");
    const len = Number.parseInt(hex, 16);
    parts.push(lenBuf);
    total += 4;
    if (len === 0) {
      return { raw: Buffer.concat(parts), updates: parseRefUpdates(payloads) };
    }
    if (len === 1 || len === 2) continue;
    if (len < 4) throw new Error("bad pkt-line length");
    const payload = await reader.read(len - 4);
    if (payload.length < len - 4) throw new Error("truncated pkt-line");
    parts.push(payload);
    payloads.push(payload);
    total += payload.length;
  }
  throw new Error("ref command section too large");
}

const OID = "(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})";
const REF_LINE = new RegExp(`^(${OID}) (${OID}) (\\S+)$`);

function parseRefUpdates(payloads: Buffer[]): RefUpdate[] | null {
  const updates: RefUpdate[] = [];
  let sawOther = false;
  for (const payload of payloads) {
    const text = payload.toString("utf8");
    const nul = text.indexOf("\0");
    const head = (nul === -1 ? text : text.slice(0, nul)).replace(/\n$/, "");
    const caps = nul === -1 ? "" : text.slice(nul + 1).replace(/\n$/, "").trim();
    const match = REF_LINE.exec(head);
    if (!match) {
      if (head.length > 0) sawOther = true;
      continue;
    }
    const oldOid = match[1]!.toLowerCase();
    const newOid = match[2]!.toLowerCase();
    if (oldOid.length !== newOid.length) {
      sawOther = true;
      continue;
    }
    updates.push({ oldOid, newOid, ref: match[3]!, capabilities: caps });
  }
  // A certificate or any other non-ref pkt-line is not a push we can check, even when
  // none of those lines parsed as a ref update. An empty section still forwards.
  if (sawOther) throw new Error("mixed receive-pack command");
  if (updates.length === 0) return null;
  return updates;
}

function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload) : payload;
  const len = body.length + 4;
  if (len > 0xffff) throw new Error("pkt-line too long");
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, "0")), body]);
}

type Route =
  | { kind: "info" | "upload" | "receive"; search: string }
  | "bad"
  | "other";

function routeOf(rawUrl: string, owner: string, repo: string): Route {
  let url: URL;
  try {
    url = new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return "bad";
  }
  const pathname = decodePath(url.pathname);
  if (pathname === null) return "bad";
  const prefix = `/${owner}/${repo}.git`;
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return "other";
  const rest = pathname.slice(prefix.length);
  const search = url.search;
  if (rest === "/info/refs") return { kind: "info", search };
  if (rest === "/git-upload-pack") return { kind: "upload", search };
  if (rest === "/git-receive-pack") return { kind: "receive", search };
  return "other";
}

function decodePath(pathname: string): string | null {
  if (pathname.includes("\\") || pathname.includes("\0") || pathname.includes("%00")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return null;
  for (const part of decoded.split("/")) {
    if (part === "." || part === "..") return null;
  }
  return decoded;
}

function serviceOf(search: string): "git-upload-pack" | "git-receive-pack" | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const keys = [...params.keys()];
  if (keys.length !== 1 || keys[0] !== "service") return null;
  const service = params.get("service");
  if (service === "git-upload-pack" || service === "git-receive-pack") return service;
  return null;
}

async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: string,
  ctx: HandleCtx,
  body: Readable | undefined,
): Promise<void> {
  const url = new URL(upstream);
  const headers: http.OutgoingHttpHeaders = {
    authorization: `Basic ${authHeaderSecret(ctx.token)}`,
    host: url.host,
  };
  const contentType = headerOne(req.headers["content-type"]);
  if (contentType) headers["content-type"] = contentType;
  const accept = headerOne(req.headers["accept"]);
  if (accept && accept.length < 200 && !textHasSecret(accept, ctx.needles)) headers.accept = accept;
  const gitProtocol = headerOne(req.headers["git-protocol"]);
  if (gitProtocol && /^version=\d+$/.test(gitProtocol)) headers["git-protocol"] = gitProtocol;
  const userAgent = headerOne(req.headers["user-agent"]);
  if (userAgent && /^git\/[A-Za-z0-9.+\-]+$/.test(userAgent)) headers["user-agent"] = userAgent;
  const contentLength = headerOne(req.headers["content-length"]);
  if (body && contentLength && /^\d+$/.test(contentLength)) headers["content-length"] = contentLength;

  const lib = url.protocol === "https:" ? https : http;
  const kind = url.pathname.endsWith("/info/refs")
    ? "info/refs"
    : url.pathname.endsWith("/git-upload-pack")
      ? "git-upload-pack"
      : "git-receive-pack";

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const ureq = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: req.method,
        headers,
      },
      (ures) => {
        const status = ures.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          ures.resume();
          ctx.log(`git proxy ${kind} -> redirect refused`);
          if (!res.headersSent) sendText(res, 502, "git proxy: upstream redirect refused\n");
          finish();
          return;
        }
        const outHeaders: http.OutgoingHttpHeaders = {};
        const upstreamType = headerOne(ures.headers["content-type"]);
        if (upstreamType && !textHasSecret(upstreamType, ctx.needles)) outHeaders["content-type"] = upstreamType;
        for (const name of ["cache-control", "expires", "pragma"] as const) {
          const value = headerOne(ures.headers[name]);
          if (value && !textHasSecret(value, ctx.needles)) outHeaders[name] = value;
        }
        ctx.log(`git proxy ${kind} -> ${status}`);
        if (res.headersSent || res.writableEnded) {
          ures.resume();
          finish();
          return;
        }
        res.writeHead(status, outHeaders);
        pipeline(ures, createScrubber(ctx.needles), res).then(
          () => finish(),
          () => {
            if (!res.destroyed) res.destroy();
            finish();
          },
        );
      },
    );
    const fail = () => {
      body?.destroy();
      ctx.log(`git proxy ${kind} -> upstream connection dropped`);
      if (!res.headersSent) sendText(res, 502, "git proxy: upstream connection dropped\n");
      else res.destroy();
      finish();
    };
    ureq.on("error", fail);
    // 'close' also fires after a normal end; only abort the upstream if we never finished the response.
    res.on("close", () => {
      if (!settled && !res.writableFinished) ureq.destroy();
    });
    if (body) {
      body.on("error", () => ureq.destroy());
      body.pipe(ureq);
    } else {
      ureq.end();
    }
  });
}

function headerOne(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  return undefined;
}

function sendText(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent || res.writableEnded) return;
  const buf = Buffer.from(body);
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "content-length": buf.length,
    "cache-control": "no-cache",
  });
  res.end(buf);
}

function errName(err: unknown): string {
  if (err instanceof Error) return err.name || "Error";
  return "Error";
}

function secretNeedles(token: string): Buffer[] {
  const b64 = authHeaderSecret(token);
  const values = [token, b64, `Basic ${b64}`, `basic ${b64}`];
  return values.filter((value) => value.length >= 8).map((value) => Buffer.from(value));
}

function textHasSecret(text: string, needles: Buffer[]): boolean {
  const buf = Buffer.from(text);
  return needles.some((needle) => buf.includes(needle));
}

function scrubText(text: string, needles: Buffer[]): string {
  return scrubBuffer(Buffer.from(text), needles).toString("utf8");
}

function scrubBuffer(buf: Buffer, needles: Buffer[]): Buffer {
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  let out = buf;
  for (const needle of ordered) {
    if (needle.length === 0 || !out.includes(needle)) continue;
    const parts: Buffer[] = [];
    let start = 0;
    let idx = out.indexOf(needle);
    while (idx !== -1) {
      parts.push(out.subarray(start, idx), REDACTED);
      start = idx + needle.length;
      idx = out.indexOf(needle, start);
    }
    parts.push(out.subarray(start));
    out = Buffer.concat(parts);
  }
  return out;
}

function longestProperPrefixSuffix(buf: Buffer, needles: Buffer[]): number {
  const max = needles.reduce((n, needle) => Math.max(n, needle.length), 0);
  const limit = Math.min(buf.length, max - 1);
  let keep = 0;
  for (let size = limit; size > keep; size--) {
    const suffix = buf.subarray(buf.length - size);
    for (const needle of needles) {
      if (needle.length > size && needle.subarray(0, size).equals(suffix)) {
        keep = size;
        break;
      }
    }
  }
  return keep;
}

function createScrubber(needles: Buffer[]): Transform {
  let pending: Buffer = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _enc, cb) {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      pending = Buffer.concat([pending, incoming]);
      pending = scrubBuffer(pending, needles);
      const keep = longestProperPrefixSuffix(pending, needles);
      if (pending.length <= keep) {
        cb();
        return;
      }
      const emit = pending.subarray(0, pending.length - keep);
      pending = Buffer.from(pending.subarray(pending.length - keep));
      cb(null, emit);
    },
    flush(cb) {
      const rest = pending;
      pending = Buffer.alloc(0);
      cb(null, scrubBuffer(rest, needles));
    },
  });
}

/** Reads the request body pkt by pkt without pulling the pack that follows the command flush. */
class ByteReader {
  private buf = Buffer.alloc(0);
  private ended = false;
  private error: Error | undefined;
  private waiter: ((chunk: Buffer | null) => void) | undefined;
  private detached = false;

  constructor(private readonly req: IncomingMessage) {
    this.req.on("data", this.onData);
    this.req.on("end", this.onEnd);
    this.req.on("error", this.onError);
    this.req.pause();
  }

  async read(n: number): Promise<Buffer> {
    while (this.buf.length < n && !this.ended && !this.error) await this.pull();
    if (this.error) throw this.error;
    if (this.buf.length < n) {
      const rest = this.buf;
      this.buf = Buffer.alloc(0);
      return rest;
    }
    const out = Buffer.from(this.buf.subarray(0, n));
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Unread tail, with `prefix` (the command section already consumed) put back in front. */
  restPrefixed(prefix: Buffer): Readable {
    const head = this.buf;
    this.buf = Buffer.alloc(0);
    const ended = this.ended;
    const req = this.req;
    this.detach();
    if (ended) {
      const chunks = [];
      if (prefix.length) chunks.push(prefix);
      if (head.length) chunks.push(head);
      return Readable.from(chunks);
    }
    return Readable.from(
      (async function* () {
        if (prefix.length) yield prefix;
        if (head.length) yield head;
        for await (const chunk of req) yield chunk as Buffer;
      })(),
    );
  }

  async drain(): Promise<void> {
    const ended = this.ended;
    this.buf = Buffer.alloc(0);
    this.detach();
    if (ended) return;
    this.req.resume();
    await finished(this.req).catch(() => {});
  }

  private pull(): Promise<void> {
    // Do not return just because `buf` is non-empty: `read` calls this when it still needs more.
    if (this.ended) {
      if (this.error) return Promise.reject(this.error);
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.waiter = (chunk) => {
        if (chunk && chunk.length) this.buf = Buffer.concat([this.buf, chunk]);
        if (this.error) reject(this.error);
        else resolve();
      };
      this.req.resume();
    });
  }

  private onData = (chunk: Buffer): void => {
    this.req.pause();
    if (this.waiter) {
      const wait = this.waiter;
      this.waiter = undefined;
      wait(chunk);
      return;
    }
    this.buf = Buffer.concat([this.buf, chunk]);
  };

  private onEnd = (): void => {
    this.ended = true;
    const wait = this.waiter;
    this.waiter = undefined;
    wait?.(null);
  };

  private onError = (err: Error): void => {
    this.error = err;
    const wait = this.waiter;
    this.waiter = undefined;
    wait?.(null);
  };

  private detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.req.off("data", this.onData);
    this.req.off("end", this.onEnd);
    this.req.off("error", this.onError);
    this.waiter = undefined;
  }
}
