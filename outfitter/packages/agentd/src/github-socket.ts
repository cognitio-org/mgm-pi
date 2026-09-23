/**
 * Unix socket the model (and kernal's BrokerBackend) uses for GitHub API calls.
 * One JSON object per line, UTF-8, newline terminated. The same object is the up/down
 * frame on the API link (`github.request` / `github.result` in protocol.ts).
 *
 * The model's shell can connect (`nc -U` runs as `agent`), so this process enforces
 * nothing about `op` or `args`: it forwards them. Policy ("not permitted", the session
 * repo, merge) is the API's, and that error string is written back unchanged.
 *
 * The GitHub token is not an input here. It must not be logged or copied into a result
 * this module builds. Client bytes are never interpolated into a log line.
 *
 * Reliability: these frames are not seq/ack replayed. A request that carries a string
 * `idempotencyKey` is a write — sent at most once. Anything else is a read and may be
 * sent one more time after the API link reconnects. A dropped link, or a second drop
 * of a read, is `ok:false` with `error:"api link dropped"` for that reqId.
 */
import net from "node:net";
import { chmod, chown, mkdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { splitJsonlChunk } from "./pi.js";
import type { DownGithubResult, UpGithubRequest } from "./protocol.js";

const MAX_LINE = 1024 * 1024;
const MAX_ID = 200;

const DROPPED = "api link dropped";
const INVALID = "invalid github request";
const DUPLICATE = "duplicate reqId";
const CLOSED = "github broker closed";

export interface GithubSocket {
  readonly path: string;
  close(): Promise<void>;
  /** API down-frame. Unknown reqIds (already finished, or never forwarded) are ignored. */
  deliver(msg: DownGithubResult): void;
  /** The API WebSocket dropped. Fail in-flight writes; queue one resend for a read. */
  onLinkDown(): void;
  /** The API WebSocket is open again. Send any read that is still owed a try. */
  onLinkUp(): void;
}

export interface GithubSocketOptions {
  path: string;
  /** `chown 0:group` after listen. The sandbox passes the `agent` gid. */
  group?: number;
  /** When false at start, writes fail immediately and reads wait for `onLinkUp`. */
  linkOpen?: boolean;
  send: (msg: UpGithubRequest) => void;
  log?: (line: string) => void;
  /** Test double. Default: real `chown`, skipped with EPERM when this process is not root. */
  chown?: (path: string, uid: number, gid: number) => Promise<void>;
  /** Called synchronously, before listen, so a link drop during chmod still reaches this broker. */
  attach?: (socket: GithubSocket) => void;
}

interface Inflight {
  frame: UpGithubRequest;
  write: boolean;
  sends: number;
  needsResend: boolean;
  socket: net.Socket;
}

export async function listenGithubSocket(opts: GithubSocketOptions): Promise<GithubSocket> {
  const log = opts.log ?? (() => {});
  const chownImpl = opts.chown ?? defaultChown;
  const path = opts.path;
  await mkdir(dirname(path), { recursive: true });
  await unlinkStaleSocket(path);

  const inflight = new Map<string, Inflight>();
  const sockets = new Set<net.Socket>();
  let linkUp = opts.linkOpen !== false;
  let closed = false;
  let armed = false;
  const held: net.Socket[] = [];

  function arm(socket: net.Socket): void {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
      for (const [reqId, inf] of inflight) {
        if (inf.socket === socket) inflight.delete(reqId);
      }
    });
    socket.on("error", () => {
      // EPIPE / ECONNRESET once the client has gone. Destroying is the close handler's job.
    });
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (closed) return;
      buf += chunk;
      if (buf.length > MAX_LINE) {
        writeLine(socket, result(false, "", INVALID));
        buf = "";
        socket.destroy();
        return;
      }
      const split = splitJsonlChunk(buf);
      buf = split.rest;
      for (const line of split.lines) {
        if (line.length === 0) continue;
        try {
          onLine(socket, line);
        } catch {
          writeLine(socket, result(false, "", INVALID));
        }
      }
    });
    socket.resume();
  }

  const server = net.createServer((socket) => {
    // 0777 & ~umask until chmod below. Don't read a request in that window, and don't
    // read one before the caller has attached link-down handling.
    if (!armed) {
      socket.pause();
      held.push(socket);
      return;
    }
    arm(socket);
  });

  const broker: GithubSocket = {
    path,
    deliver(msg) {
      if (closed || msg.t !== "github.result") return;
      const inf = inflight.get(msg.reqId);
      if (!inf) return;
      inflight.delete(inf.frame.reqId);
      if (msg.ok === true) {
        writeLine(inf.socket, {
          t: "github.result",
          reqId: msg.reqId,
          ok: true,
          data: plain(msg.data) ? msg.data : {},
        });
        return;
      }
      const error = typeof msg.error === "string" ? msg.error : "github request failed";
      writeLine(inf.socket, result(false, msg.reqId, error));
    },
    onLinkDown() {
      linkUp = false;
      for (const inf of [...inflight.values()]) {
        if (inf.write || inf.sends >= 2) fail(inf, DROPPED);
        else inf.needsResend = true;
      }
    },
    onLinkUp() {
      linkUp = true;
      for (const inf of [...inflight.values()]) {
        if (inf.needsResend) sendNow(inf);
      }
    },
    close() {
      if (closed) return Promise.resolve();
      closed = true;
      linkUp = false;
      for (const inf of [...inflight.values()]) fail(inf, CLOSED);
      for (const socket of held) socket.destroy();
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
      }).then(async () => {
        await unlink(path).catch(() => {});
      });
    },
  };
  // Before listen, so RunController can observe link drops while chmod is still in flight.
  // Connections stay paused until `armed` after chmod.
  opts.attach?.(broker);

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off("error", onError);
        reject(err);
      };
      server.once("error", onError);
      server.listen(path, () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (err) {
    for (const socket of held) socket.destroy();
    server.close();
    throw err;
  }

  try {
    // listen() creates the inode as 0777 & ~umask. Root's umask (022 in the image) would
    // leave it 0755, not group-writable, and `agent` could not connect. Same trap as the
    // spend file: set the mode explicitly after create.
    await chmod(path, 0o660);
    if (opts.group !== undefined) {
      try {
        await chownImpl(path, 0, opts.group);
      } catch (err) {
        log(`github socket chown failed: ${codeOf(err)}`);
      }
    }
  } catch (err) {
    for (const socket of held) socket.destroy();
    server.close();
    await unlink(path).catch(() => {});
    throw err;
  }
  server.on("error", (err) => log(`github socket error: ${codeOf(err)}`));
  log("github socket listening");
  armed = true;
  for (const socket of held) arm(socket);
  held.length = 0;

  function fail(inf: Inflight, error: string): void {
    if (inflight.get(inf.frame.reqId) !== inf) return;
    inflight.delete(inf.frame.reqId);
    writeLine(inf.socket, result(false, inf.frame.reqId, error));
  }

  function sendNow(inf: Inflight): void {
    if (inflight.get(inf.frame.reqId) !== inf) return;
    inf.needsResend = false;
    inf.sends++;
    try {
      opts.send(inf.frame);
    } catch {
      fail(inf, DROPPED);
    }
  }

  function enqueueOrSend(inf: Inflight): void {
    if (!linkUp) {
      if (inf.write || inf.sends >= 2) {
        fail(inf, DROPPED);
        return;
      }
      inf.needsResend = true;
      return;
    }
    sendNow(inf);
  }

  function onLine(socket: net.Socket, line: string): void {
    const parsed = parseRequest(line);
    if (!parsed.ok) {
      writeLine(socket, result(false, parsed.reqId, INVALID));
      return;
    }
    if (inflight.has(parsed.frame.reqId)) {
      writeLine(socket, result(false, parsed.frame.reqId, DUPLICATE));
      return;
    }
    const inf: Inflight = {
      frame: parsed.frame,
      write: parsed.write,
      sends: 0,
      needsResend: false,
      socket,
    };
    inflight.set(parsed.frame.reqId, inf);
    enqueueOrSend(inf);
  }

  return broker;
}

function result(ok: false, reqId: string, error: string): DownGithubResult {
  return { t: "github.result", reqId, ok, error };
}

function writeLine(socket: net.Socket, msg: DownGithubResult): void {
  if (socket.destroyed) return;
  socket.write(`${JSON.stringify(msg)}\n`);
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idOrEmpty(value: unknown): string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID ? value : "";
}

function parseRequest(
  line: string,
): { ok: true; frame: UpGithubRequest; write: boolean } | { ok: false; reqId: string } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, reqId: "" };
  }
  if (!plain(value) || value.t !== "github.request") {
    return { ok: false, reqId: plain(value) ? idOrEmpty(value.reqId) : "" };
  }
  const reqId = idOrEmpty(value.reqId);
  if (!reqId) return { ok: false, reqId: "" };
  if (typeof value.op !== "string") return { ok: false, reqId };
  let args: Record<string, unknown> = {};
  if (value.args !== undefined) {
    if (!plain(value.args)) return { ok: false, reqId };
    args = value.args;
  }
  if (value.idempotencyKey !== undefined) {
    if (typeof value.idempotencyKey !== "string" || value.idempotencyKey.length > MAX_ID) {
      return { ok: false, reqId };
    }
  }
  const frame: UpGithubRequest = { t: "github.request", reqId, op: value.op, args };
  if (typeof value.idempotencyKey === "string") frame.idempotencyKey = value.idempotencyKey;
  return { ok: true, frame, write: frame.idempotencyKey !== undefined };
}

async function defaultChown(path: string, uid: number, gid: number): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    const err = new Error("not root") as NodeJS.ErrnoException;
    err.code = "EPERM";
    throw err;
  }
  await chown(path, uid, gid);
}

async function unlinkStaleSocket(path: string): Promise<void> {
  try {
    const st = await stat(path);
    if (!st.isSocket()) {
      const err = new Error("github socket path is not a socket") as NodeJS.ErrnoException;
      err.code = "ENOTSOCK";
      throw err;
    }
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

function codeOf(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return "error";
}
