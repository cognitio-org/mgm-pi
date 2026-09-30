/**
 * A Unix socket the model (through a Kernal extension) uses for one kind of brokered API call:
 * `github` (kernal-github's BrokerBackend) or `admin` (outfitter-admin, Sysop tools #287). One JSON
 * object per line, UTF-8, newline terminated. The same object is the up/down frame on the API link
 * (`<kind>.request` / `<kind>.result` in protocol.ts).
 *
 * The model's shell can connect (`nc -U` runs as `agent`), so this process enforces nothing about
 * `op` or `args`: it forwards them. Policy is the API's, and its error string is written back
 * unchanged. Credentials are not an input here and must never be logged or copied into a result
 * this module builds. Client bytes are never interpolated into a log line.
 *
 * Reliability: these frames are not seq/ack replayed. A request that carries a string
 * `idempotencyKey` is a write -- sent at most once. Anything else is a read and may be sent one more
 * time after the API link reconnects. A dropped link, or a second drop of a read, is `ok:false`
 * with `error:"api link dropped"` for that reqId.
 */
import net from "node:net";
import { chmod, chown, mkdir, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { splitJsonlChunk } from "./pi.js";


const MAX_LINE = 1024 * 1024;
const MAX_ID = 200;

const DROPPED = "api link dropped";
const DUPLICATE = "duplicate reqId";

export type BrokerKind = "github" | "admin";

/** The request frame a broker forwards, for either kind. */
export interface BrokerRequest<K extends BrokerKind = BrokerKind> {
  t: `${K}.request`;
  reqId: string;
  op: string;
  args: Record<string, unknown>;
  idempotencyKey?: string;
}

/** The result frame the API sends down, for either kind. Fields besides these are per kind: the
 * broker copies only the ones `okFields` / `errorFields` name. */
export interface BrokerResult<K extends BrokerKind = BrokerKind> {
  t: `${K}.result`;
  reqId: string;
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface BrokerSocket<K extends BrokerKind = BrokerKind> {
  readonly path: string;
  close(): Promise<void>;
  /** API down-frame. Unknown reqIds (already finished, or never forwarded) are ignored. */
  deliver(msg: BrokerResult<K>): void;
  /** The API WebSocket dropped. Fail in-flight writes; queue one resend for a read. */
  onLinkDown(): void;
  /** The API WebSocket is open again. Send any read that is still owed a try. */
  onLinkUp(): void;
}

export interface BrokerSocketOptions<K extends BrokerKind = BrokerKind> {
  kind: K;
  path: string;
  /** `chown 0:group` after listen. The sandbox passes the `agent` gid. */
  group?: number;
  /** When false at start, writes fail immediately and reads wait for `onLinkUp`. */
  linkOpen?: boolean;
  send: (msg: BrokerRequest<K>) => void;
  log?: (line: string) => void;
  /** Test double. Default: real `chown`, skipped with EPERM when this process is not root. */
  chown?: (path: string, uid: number, gid: number) => Promise<void>;
  /** Called synchronously, before listen, so a link drop during chmod still reaches this broker. */
  attach?: (socket: BrokerSocket<K>) => void;
}

/** What a successful result carries to the client, per kind. */
function okFields(kind: BrokerKind, msg: BrokerResult): Record<string, unknown> {
  if (kind === "admin") return { text: typeof msg.text === "string" ? msg.text : "" };
  return { data: plain(msg.data) ? msg.data : {} };
}

/** Extra fields a failed result may carry, per kind. */
function errorFields(kind: BrokerKind, msg: BrokerResult): Record<string, unknown> {
  return kind === "admin" && msg.needsApproval === true ? { needsApproval: true } : {};
}

interface Inflight {
  frame: BrokerRequest;
  write: boolean;
  sends: number;
  needsResend: boolean;
  socket: net.Socket;
}

export async function listenBrokerSocket<K extends BrokerKind>(opts: BrokerSocketOptions<K>): Promise<BrokerSocket<K>> {
  const kind = opts.kind;
  const INVALID = `invalid ${kind} request`;
  const CLOSED = `${kind} broker closed`;
  const resultType = `${kind}.result` as const;
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
        writeLine(socket, result(kind, "", INVALID));
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
          writeLine(socket, result(kind, "", INVALID));
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

  const broker: BrokerSocket<K> = {
    path,
    deliver(msg) {
      if (closed || msg.t !== resultType) return;
      const inf = inflight.get(msg.reqId);
      if (!inf) return;
      inflight.delete(inf.frame.reqId);
      if (msg.ok === true) {
        writeLine(inf.socket, { t: resultType, reqId: msg.reqId, ok: true, ...okFields(kind, msg) });
        return;
      }
      const error = typeof msg.error === "string" ? msg.error : `${kind} request failed`;
      writeLine(inf.socket, { ...result(kind, msg.reqId, error), ...errorFields(kind, msg) });
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
        log(`${kind} socket chown failed: ${codeOf(err)}`);
      }
    }
  } catch (err) {
    for (const socket of held) socket.destroy();
    server.close();
    await unlink(path).catch(() => {});
    throw err;
  }
  server.on("error", (err) => log(`${kind} socket error: ${codeOf(err)}`));
  log(`${kind} socket listening`);
  armed = true;
  for (const socket of held) arm(socket);
  held.length = 0;

  function fail(inf: Inflight, error: string): void {
    if (inflight.get(inf.frame.reqId) !== inf) return;
    inflight.delete(inf.frame.reqId);
    writeLine(inf.socket, result(kind, inf.frame.reqId, error));
  }

  function sendNow(inf: Inflight): void {
    if (inflight.get(inf.frame.reqId) !== inf) return;
    inf.needsResend = false;
    inf.sends++;
    try {
      opts.send(inf.frame as BrokerRequest<K>);
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
    const parsed = parseRequest(kind, line);
    if (!parsed.ok) {
      writeLine(socket, result(kind, parsed.reqId, INVALID));
      return;
    }
    if (inflight.has(parsed.frame.reqId)) {
      writeLine(socket, result(kind, parsed.frame.reqId, DUPLICATE));
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

function result(kind: BrokerKind, reqId: string, error: string): BrokerResult {
  return { t: `${kind}.result`, reqId, ok: false, error };
}

function writeLine(socket: net.Socket, msg: BrokerResult): void {
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
  kind: BrokerKind,
  line: string,
): { ok: true; frame: BrokerRequest; write: boolean } | { ok: false; reqId: string } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, reqId: "" };
  }
  if (!plain(value) || value.t !== `${kind}.request`) {
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
  const frame: BrokerRequest = { t: `${kind}.request`, reqId, op: value.op, args };
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
      const err = new Error("broker socket path is not a socket") as NodeJS.ErrnoException;
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
