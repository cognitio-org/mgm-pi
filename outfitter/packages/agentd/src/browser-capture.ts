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
import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { lstat, mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
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

/** Tool text when `.outfitter` or `captures` is a symlink or is not owned by the expected user.
 * The link target is left untouched. */
export const CAPTURE_PATH_REFUSED = "capture path refused";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
/** Open fails if the final component is a symlink (ELOOP or ENOTDIR). Not a path walk. */
const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

class CapturePathRefused extends Error {
  constructor(message = CAPTURE_PATH_REFUSED) {
    super(message);
    this.name = "CapturePathRefused";
  }
}

interface CaptureOwner {
  uid: number;
  gid: number;
}

type ChildKind = "missing" | "link" | "dir" | "other";

interface ChildInfo {
  kind: ChildKind;
  uid?: number;
  gid?: number;
}

/** One path component. Never joined onto a parent the sandbox can swap for a symlink. */
function assertComponent(name: string): string {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    throw new CapturePathRefused();
  }
  return name;
}

/** Process uid, or the agent uid after chown. A directory owned by anyone else is refused. */
function uidAllowed(uid: number | undefined, chownTo: CaptureOwner | undefined): boolean {
  if (uid === undefined) return false;
  const self = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (self !== undefined && uid === self) return true;
  return chownTo !== undefined && uid === chownTo.uid;
}

function procChild(parentFd: number, name: string): string {
  return `/proc/self/fd/${parentFd}/${assertComponent(name)}`;
}

/** Node has no mkdirat/openat. On Linux the directory fd is `/proc/self/fd/N`, which is
 * mkdirat/openat. Elsewhere python's `dir_fd` is the same call. The sandbox user can replace
 * a path component; the fd cannot. */
const DIRFD_PY = `
import os, stat, sys
parent = 3
name = sys.argv[1]
op = sys.argv[2]
if name in ("", ".", "..") or "/" in name or "\\0" in name:
    sys.exit(2)
nofollow = getattr(os, "O_NOFOLLOW", 0)

def show():
    try:
        st = os.lstat(name, dir_fd=parent)
    except FileNotFoundError:
        print("missing")
        return
    if stat.S_ISLNK(st.st_mode):
        print("link")
    elif stat.S_ISDIR(st.st_mode):
        print("dir %s %s" % (st.st_uid, st.st_gid))
    else:
        print("other %s %s" % (st.st_uid, st.st_gid))

def chown(fd):
    if len(sys.argv) < 6:
        return
    try:
        os.fchown(fd, int(sys.argv[4]), int(sys.argv[5]))
    except PermissionError:
        pass

if op == "lstat":
    show()
elif op == "mkdir":
    mode = int(sys.argv[3])
    try:
        os.mkdir(name, mode, dir_fd=parent)
    except FileExistsError:
        pass
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | nofollow, dir_fd=parent)
    os.fchmod(fd, mode)
    chown(fd)
    st = os.fstat(fd)
    os.close(fd)
    if not stat.S_ISDIR(st.st_mode):
        sys.exit(3)
elif op == "unlink":
    try:
        os.unlink(name, dir_fd=parent)
    except FileNotFoundError:
        pass
elif op == "write":
    mode = int(sys.argv[3])
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow
    fd = os.open(name, flags, mode, dir_fd=parent)
    data = sys.stdin.buffer.read()
    while data:
        n = os.write(fd, data)
        data = data[n:]
    os.fchmod(fd, mode)
    chown(fd)
    st = os.fstat(fd)
    os.close(fd)
    if not stat.S_ISREG(st.st_mode):
        sys.exit(3)
else:
    sys.exit(2)
`;

function pythonDirFd(parentFd: number, args: string[], input?: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-c", DIRFD_PY, ...args], {
      stdio: ["pipe", "pipe", "pipe", parentFd],
    });
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => errOut.push(chunk));
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new CapturePathRefused("python dirfd timed out")));
    }, 10_000);
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) => {
      finish(() => {
        if (code !== 0) {
          reject(new Error(Buffer.concat(errOut).toString("utf8") || `python dirfd exited ${code}`));
          return;
        }
        resolve(Buffer.concat(out).toString("utf8"));
      });
    });
    child.stdin?.end(input ?? Buffer.alloc(0));
  });
}

function parseChild(stdout: string): ChildInfo {
  const line = stdout.trim();
  if (line === "missing") return { kind: "missing" };
  if (line === "link") return { kind: "link" };
  const dir = /^dir (\d+) (\d+)$/.exec(line);
  if (dir) return { kind: "dir", uid: Number(dir[1]), gid: Number(dir[2]) };
  const other = /^other (\d+) (\d+)$/.exec(line);
  if (other) return { kind: "other", uid: Number(other[1]), gid: Number(other[2]) };
  throw new CapturePathRefused();
}

function infoFromStat(st: Stats): ChildInfo {
  if (st.isSymbolicLink()) return { kind: "link" };
  if (st.isDirectory()) return { kind: "dir", uid: st.uid, gid: st.gid };
  return { kind: "other", uid: st.uid, gid: st.gid };
}

async function childInfo(parent: FileHandle, name: string): Promise<ChildInfo> {
  const component = assertComponent(name);
  if (process.platform === "linux") {
    try {
      return infoFromStat(await lstat(procChild(parent.fd, component)));
    } catch (err: any) {
      if (err?.code === "ENOENT") return { kind: "missing" };
      if (err?.code === "ELOOP" || err?.code === "ENOTDIR") return { kind: "link" };
      throw err;
    }
  }
  return parseChild(await pythonDirFd(parent.fd, [component, "lstat"]));
}

async function openNoFollow(path: string): Promise<FileHandle> {
  try {
    const handle = await open(path, DIR_FLAGS);
    const st = await handle.stat();
    if (!st.isDirectory()) {
      await handle.close();
      throw new CapturePathRefused();
    }
    return handle;
  } catch (err) {
    if (err instanceof CapturePathRefused) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR" || code === "ENOENT" || code === "EPERM" || code === "ENOTSUP") {
      throw new CapturePathRefused();
    }
    throw err;
  }
}

async function chownHandle(handle: FileHandle, chownTo: CaptureOwner | undefined, log: (line: string) => void): Promise<void> {
  if (!chownTo) return;
  try {
    await handle.chown(chownTo.uid, chownTo.gid);
  } catch (err: any) {
    // Outside the image agentd isn't root. The file stays mode 0600 owned by this user.
    log(`browser capture chown skipped: ${err?.message ?? err}`);
  }
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
    try {
      await this.writeCapture(frame.captureId, bytes);
    } catch (err) {
      if (err instanceof CapturePathRefused) {
        this.onLog(`browser capture path refused: ${err.message}`);
        return { error: CAPTURE_PATH_REFUSED };
      }
      throw err;
    }
    return { title: frame.title, url: frame.url, path };
  }

  /**
   * `.outfitter` and `captures` are created through the parent directory fd (O_NOFOLLOW / mkdirat).
   * A symlink the sandbox user planted is refused. chmod and the jpeg write use that fd too, so
   * they cannot follow the link.
   */
  private async writeCapture(captureId: string, bytes: Buffer): Promise<void> {
    const fileName = `${assertComponent(captureId)}.jpg`;
    const workspace = await openNoFollow(this.opts.workspace);
    try {
      const outfitter = await this.ensureDir(workspace, this.opts.workspace, ".outfitter");
      try {
        const captures = await this.ensureDir(outfitter, join(this.opts.workspace, ".outfitter"), "captures");
        try {
          await this.writeJpeg(captures, fileName, bytes);
        } finally {
          await captures.close();
        }
      } finally {
        await outfitter.close();
      }
    } finally {
      await workspace.close();
    }
  }

  private async ensureDir(parent: FileHandle, parentPath: string, name: string): Promise<FileHandle> {
    const info = await childInfo(parent, name);
    if (info.kind === "link" || info.kind === "other" || (info.kind === "dir" && !uidAllowed(info.uid, this.opts.chownTo))) {
      throw new CapturePathRefused();
    }
    if (info.kind === "missing") await this.makeChildDir(parent, name);
    const child = await this.openChildDir(parent, parentPath, name);
    try {
      const st = await child.stat();
      if (!st.isDirectory() || !uidAllowed(st.uid, this.opts.chownTo)) throw new CapturePathRefused();
      await child.chmod(DIR_MODE);
      await chownHandle(child, this.opts.chownTo, this.onLog);
      return child;
    } catch (err) {
      await child.close();
      throw err;
    }
  }

  private async makeChildDir(parent: FileHandle, name: string): Promise<void> {
    const component = assertComponent(name);
    if (process.platform === "linux") {
      const path = procChild(parent.fd, component);
      try {
        await mkdir(path, { mode: DIR_MODE });
      } catch (err: any) {
        if (err?.code !== "EEXIST") throw err;
      }
      const child = await this.openProc(path);
      try {
        const st = await child.stat();
        if (!st.isDirectory()) throw new CapturePathRefused();
        await child.chmod(DIR_MODE);
        await chownHandle(child, this.opts.chownTo, this.onLog);
      } finally {
        await child.close();
      }
      return;
    }
    const args = [component, "mkdir", String(DIR_MODE)];
    if (this.opts.chownTo) args.push(String(this.opts.chownTo.uid), String(this.opts.chownTo.gid));
    try {
      await pythonDirFd(parent.fd, args);
    } catch (err: any) {
      this.onLog(`browser capture mkdir refused: ${err?.message ?? err}`);
      throw new CapturePathRefused();
    }
  }

  private async openChildDir(parent: FileHandle, parentPath: string, name: string): Promise<FileHandle> {
    const component = assertComponent(name);
    try {
      if (process.platform === "linux") return await this.openProc(procChild(parent.fd, component));
      return await openNoFollow(join(parentPath, component));
    } catch (err) {
      if (err instanceof CapturePathRefused) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "ENOTDIR" || code === "ENOENT" || code === "EEXIST") throw new CapturePathRefused();
      throw err;
    }
  }

  private async openProc(path: string): Promise<FileHandle> {
    let handle: FileHandle;
    try {
      handle = await open(path, DIR_FLAGS);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "ENOTDIR" || code === "ENOENT" || code === "EEXIST") throw new CapturePathRefused();
      throw err;
    }
    const st = await handle.stat();
    if (!st.isDirectory()) {
      await handle.close();
      throw new CapturePathRefused();
    }
    return handle;
  }

  /** Removes a file or symlink in `dir`. unlink does not follow a final symlink, so the target stays. */
  private async unlinkChild(dir: FileHandle, name: string): Promise<void> {
    const component = assertComponent(name);
    if (process.platform === "linux") {
      try {
        await unlink(procChild(dir.fd, component));
      } catch (err: any) {
        if (err?.code !== "ENOENT") throw err;
      }
      return;
    }
    try {
      await pythonDirFd(dir.fd, [component, "unlink"]);
    } catch (err: any) {
      this.onLog(`browser capture unlink refused: ${err?.message ?? err}`);
      throw new CapturePathRefused();
    }
  }

  /** O_EXCL|O_NOFOLLOW: the jpeg is a regular file this process created, or the call fails. */
  private async writeJpeg(dir: FileHandle, name: string, bytes: Buffer): Promise<void> {
    const info = await childInfo(dir, name);
    // A directory in the jpeg's place is left alone. A file or symlink is removed (the symlink
    // itself, not its target) so this call can create a regular file.
    if (info.kind === "dir") throw new CapturePathRefused();
    if (info.kind !== "missing") await this.unlinkChild(dir, name);
    const component = assertComponent(name);
    if (process.platform !== "linux") {
      const args = [component, "write", String(FILE_MODE)];
      if (this.opts.chownTo) args.push(String(this.opts.chownTo.uid), String(this.opts.chownTo.gid));
      try {
        await pythonDirFd(dir.fd, args, bytes);
      } catch (err: any) {
        this.onLog(`browser capture write refused: ${err?.message ?? err}`);
        throw new CapturePathRefused();
      }
      return;
    }
    let handle: FileHandle;
    try {
      handle = await open(procChild(dir.fd, component), FILE_FLAGS, FILE_MODE);
    } catch (err: any) {
      if (err?.code === "EEXIST" || err?.code === "ELOOP" || err?.code === "ENOTDIR") throw new CapturePathRefused();
      throw err;
    }
    try {
      await handle.writeFile(bytes);
      await handle.chmod(FILE_MODE);
      const st = await handle.stat();
      if (!st.isFile()) throw new CapturePathRefused();
      await chownHandle(handle, this.opts.chownTo, this.onLog);
    } finally {
      await handle.close();
    }
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
