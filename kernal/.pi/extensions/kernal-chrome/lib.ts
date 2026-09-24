/**
 * Local Chrome companion socket. Kernal is the unix-socket client. Nothing here
 * uses the network: a missing socket is "not running", not an HTTP call.
 *
 * pi 0.87 (the version kernal pins) types a tool result as (TextContent | ImageContent)[].
 * ImageContent is { type: "image", data: base64, mimeType }, which is what the read tool returns.
 */
import { connect, type Socket } from "node:net";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { homedir } from "node:os";

export const NOT_RUNNING = "The Chrome companion is not running.";
export const NOT_SHARED = "That tab is not shared.";
export const NOT_CONNECTED = "The Chrome extension is not connected.";
export const NO_ANSWER = "The Chrome companion did not answer.";
export const CAPTURE_DIR = "chrome-captures";

const SOCKET_NAME = "chrome.sock";

export type Share = { tabId: number; title: string; url: string; sessionId: string };
export type HostMessage = { t?: string; error?: unknown; shares?: unknown; tabId?: unknown; title?: unknown; url?: unknown; path?: unknown };
export type ToolText = { text: string; isError: boolean; image?: Buffer };

export type CallOptions = {
  env?: NodeJS.ProcessEnv;
  home?: string;
  readFile?: (file: string) => string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** Same home the host's socketPathFrom uses when Chrome did not leave an install record. */
export function kernalHome(env: NodeJS.ProcessEnv, osHome: string): string {
  if (typeof env.KERNAL_HOME === "string" && env.KERNAL_HOME !== "") return env.KERNAL_HOME;
  const legacy = join(osHome, ".mgm");
  if (typeof env.MGM_HOME === "string" && env.MGM_HOME !== "" && env.MGM_HOME !== legacy) return env.MGM_HOME;
  return join(osHome, ".kernal");
}

/**
 * The socket the host is listening on. The install record wins (`<home>/chrome/host/socket-path`,
 * which install.sh writes as `<home>/chrome.sock`). Otherwise `<home>/chrome.sock`.
 */
export function chromeSocketPath(options: CallOptions = {}): string {
  const env = options.env ?? process.env;
  const osHome = options.home ?? homedir();
  const readFile = options.readFile ?? ((file: string) => readFileSync(file, "utf8"));
  const root = kernalHome(env, osHome);
  try {
    const line = String(readFile(join(root, "chrome", "host", "socket-path"))).trim();
    if (line.startsWith("/") && basename(line) === SOCKET_NAME) return line;
  } catch {
    /* a checkout has no record; the socket is still <home>/chrome.sock */
  }
  return join(root, SOCKET_NAME);
}

export function parseTabId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    const n = Number(value);
    if (Number.isSafeInteger(n) && n >= 0) return n;
  }
  return null;
}

function isShare(value: unknown): value is Share {
  if (value === null || typeof value !== "object") return false;
  const share = value as Share;
  return Number.isInteger(share.tabId) && typeof share.title === "string" && typeof share.url === "string" && typeof share.sessionId === "string";
}

export function formatShareList(shares: Share[]): string {
  if (shares.length === 0) return "No tabs are shared.";
  return shares.map((share) => `tabId: ${share.tabId}\ntitle: ${share.title}\nurl: ${share.url}\nsessionId: ${share.sessionId}`).join("\n\n");
}

export function formatCapture(info: { title: string; url: string; path: string }): string {
  return `title: ${info.title}\nurl: ${info.url}\npath: ${info.path}`;
}

export function mapHostError(error: unknown): string {
  if (error === "tab is not shared" || error === "not_shared") return NOT_SHARED;
  if (error === "not connected") return NOT_CONNECTED;
  if (typeof error === "string" && error.length > 0 && error.length <= 200 && !error.includes("\n")) return error;
  return "The Chrome companion could not capture that tab.";
}

export function thrownText(err: unknown): string {
  const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code?: unknown }).code) : "";
  if (code === "ENOTRUNNING" || code === "ENOENT" || code === "ECONNREFUSED" || code === "ENOTSOCK") return NOT_RUNNING;
  if (code === "ETIMEDOUT" || code === "ECLOSED" || code === "ABORT_ERR") return NO_ANSWER;
  if (err instanceof Error && err.message === NOT_RUNNING) return NOT_RUNNING;
  return NO_ANSWER;
}

/** pi image block. data is raw base64, not a data URL. */
export function imageContent(bytes: Buffer): { type: "image"; data: string; mimeType: string } {
  return { type: "image", data: bytes.toString("base64"), mimeType: "image/jpeg" };
}

export function requestHost(socketPath: string, payload: object, accept: (msg: HostMessage) => boolean, options: { timeoutMs: number; signal?: AbortSignal }): Promise<HostMessage> {
  return new Promise((resolve, reject) => {
    let socket: Socket | null = null;
    let settled = false;
    let connected = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const fail = (err: Error) => finish(() => {
      socket?.destroy();
      reject(err);
    });
    const succeed = (msg: HostMessage) => finish(() => {
      socket?.end();
      resolve(msg);
    });
    const timer = setTimeout(() => fail(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), options.timeoutMs);
    const onAbort = () => fail(Object.assign(new Error("aborted"), { code: "ABORT_ERR" }));
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let buf = "";
    try {
      socket = connect(socketPath);
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    socket.on("connect", () => {
      connected = true;
      socket?.write(`${JSON.stringify(payload)}\n`);
    });
    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (!connected || err.code === "ENOENT" || err.code === "ECONNREFUSED" || err.code === "ENOTSOCK") {
        fail(Object.assign(new Error(NOT_RUNNING), { code: "ENOTRUNNING" }));
        return;
      }
      fail(err);
    });
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (buf.length > 2 * 1024 * 1024) {
        fail(new Error("rejected"));
        return;
      }
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line.trim()) continue;
        let msg: HostMessage;
        try {
          msg = JSON.parse(line) as HostMessage;
        } catch {
          continue;
        }
        if (msg.t === "share" || msg.t === "unshare") continue;
        if (accept(msg)) {
          succeed(msg);
          return;
        }
      }
    });
    socket.on("close", () => {
      if (!settled) fail(Object.assign(new Error("closed"), { code: connected ? "ECLOSED" : "ENOTRUNNING" }));
    });
  });
}

export function captureFileOk(path: unknown, tabId: number): path is string {
  return typeof path === "string" && isAbsolute(path) && basename(path) === `${tabId}.jpg`;
}

function errnoCode(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code?: unknown }).code) : "";
}

function isRealDirectory(st: ReturnType<typeof lstatSync>): boolean {
  return st.isDirectory() && !st.isSymbolicLink();
}

function isRealFile(st: ReturnType<typeof lstatSync>): boolean {
  return st.isFile() && !st.isSymbolicLink();
}

const REAL_DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** Open a real directory. O_NOFOLLOW fails closed when the path is a symlink. */
function openRealDirectory(dir: string): boolean {
  let fd: number | null = null;
  try {
    const named = lstatSync(dir);
    if (!isRealDirectory(named)) return false;
    fd = openSync(dir, REAL_DIR);
    const opened = fstatSync(fd);
    return opened.isDirectory() && opened.dev === named.dev && opened.ino === named.ino;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * chrome-captures must be a real directory. mkdir(2) does not follow a trailing symlink;
 * a link that wins the race is rejected by lstat and never used as the destination.
 */
function ensureCaptureDir(parent: string): boolean {
  const dir = join(parent, CAPTURE_DIR);
  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(dir);
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") return false;
  }
  if (existing) return isRealDirectory(existing) && openRealDirectory(dir);
  let parentFd: number | null = null;
  try {
    parentFd = openSync(parent, REAL_DIR);
    try {
      mkdirSync(dir);
    } catch (err) {
      if (errnoCode(err) !== "EEXIST") return false;
    }
    return openRealDirectory(dir);
  } catch {
    return false;
  } finally {
    if (parentFd !== null) closeSync(parentFd);
  }
}

function readRealFile(path: string): Buffer | null {
  let fd: number | null = null;
  try {
    if (!isRealFile(lstatSync(path))) return null;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Replace a regular file, or create one. A symlink (or anything else) is refused and not followed. */
function writeRealFile(path: string, bytes: Buffer): boolean {
  let existing: ReturnType<typeof lstatSync> | null = null;
  try {
    existing = lstatSync(path);
  } catch (err) {
    if (errnoCode(err) !== "ENOENT") return false;
  }
  if (existing && !isRealFile(existing)) return false;
  const flags = existing
    ? constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW
    : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  let fd: number | null = null;
  try {
    fd = openSync(path, flags, 0o600);
    if (!fstatSync(fd).isFile()) return false;
    writeFileSync(fd, bytes);
    fchmodSync(fd, 0o600);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Copy the host jpeg into the session workspace. One file per tab. Source and destination symlinks are refused. */
export function copyCapture(src: string, cwd: string, tabId: number): { rel: string; bytes: Buffer } | null {
  if (!captureFileOk(src, tabId)) return null;
  const bytes = readRealFile(src);
  if (!bytes) return null;
  const dest = join(cwd, CAPTURE_DIR, `${tabId}.jpg`);
  const rel = relative(cwd, dest);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  if (!ensureCaptureDir(cwd) || !openRealDirectory(join(cwd, CAPTURE_DIR))) return null;
  if (!writeRealFile(dest, bytes)) return null;
  const stored = readRealFile(dest);
  if (!stored) return null;
  return { rel, bytes: stored };
}

export async function browserTabs(options: CallOptions = {}): Promise<ToolText> {
  try {
    const msg = await requestHost(chromeSocketPath(options), { t: "list" }, (item) => item.t === "shares" || item.t === "error", {
      timeoutMs: options.timeoutMs ?? 5000,
      signal: options.signal,
    });
    if (msg.t === "error") return { text: mapHostError(msg.error), isError: true };
    if (msg.t !== "shares" || !Array.isArray(msg.shares)) return { text: "The Chrome companion sent an unexpected reply.", isError: true };
    return { text: formatShareList(msg.shares.filter(isShare)), isError: false };
  } catch (err) {
    return { text: thrownText(err), isError: true };
  }
}

const ACTION_SELECTOR_MAX = 500;
const ACTION_TEXT_MAX = 8000;

function actionSelectorOk(selector: string): boolean {
  if (selector.length === 0 || selector.length > ACTION_SELECTOR_MAX) return false;
  if (/[\u0000-\u001f\u007f<{}`;]/.test(selector)) return false;
  if (/javascript\s*:/i.test(selector)) return false;
  if (/eval\s*\(/i.test(selector) || /function\s*\(/i.test(selector)) return false;
  if (selector.includes("=>")) return false;
  if (/url\s*\(/i.test(selector) || /expression\s*\(/i.test(selector)) return false;
  return true;
}

export function parseActionParams(params: unknown): { kind: "click" | "type"; selector: string; text?: string } | null {
  if (params === null || typeof params !== "object") return null;
  const record = params as { kind?: unknown; selector?: unknown; text?: unknown };
  if (record.kind !== "click" && record.kind !== "type") return null;
  if (typeof record.selector !== "string" || !actionSelectorOk(record.selector.trim())) return null;
  const selector = record.selector.trim();
  if (record.kind === "click") {
    if (record.text !== undefined) return null;
    return { kind: "click", selector };
  }
  if (typeof record.text !== "string" || record.text.length > ACTION_TEXT_MAX || record.text.includes("\u0000")) return null;
  return { kind: "type", selector, text: record.text };
}

export function formatAction(info: { kind: "click" | "type"; selector: string }): string {
  return info.kind === "type" ? `Typed into ${info.selector}` : `Clicked ${info.selector}`;
}

/** Click or type in a shared tab. The extension confirms before it runs. No network. */
export async function browserAction(params: unknown, tabIdValue: unknown, options: CallOptions = {}): Promise<ToolText> {
  const tabId = parseTabId(tabIdValue);
  const action = parseActionParams(params);
  if (tabId === null) return { text: NOT_SHARED, isError: true };
  if (!action) return { text: "rejected", isError: true };
  const payload = action.kind === "type"
    ? { t: "action", tabId, kind: action.kind, selector: action.selector, text: action.text }
    : { t: "action", tabId, kind: action.kind, selector: action.selector };
  try {
    const msg = await requestHost(chromeSocketPath(options), payload, (item) => item.t === "acted" || item.t === "error", {
      timeoutMs: options.timeoutMs ?? 95_000,
      signal: options.signal,
    });
    if (msg.t === "error") return { text: mapHostError(msg.error), isError: true };
    if (msg.t !== "acted" || msg.tabId !== tabId) return { text: "The Chrome companion sent an unexpected reply.", isError: true };
    return { text: formatAction(action), isError: false };
  } catch (err) {
    return { text: thrownText(err), isError: true };
  }
}

export async function browserCapture(tabIdValue: unknown, cwd: string, options: CallOptions = {}): Promise<ToolText> {
  const tabId = parseTabId(tabIdValue);
  if (tabId === null) return { text: NOT_SHARED, isError: true };
  try {
    const msg = await requestHost(chromeSocketPath(options), { t: "capture", tabId }, (item) => item.t === "captured" || item.t === "error", {
      timeoutMs: options.timeoutMs ?? 20000,
      signal: options.signal,
    });
    if (msg.t === "error") return { text: mapHostError(msg.error), isError: true };
    if (msg.t !== "captured" || msg.tabId !== tabId || typeof msg.path !== "string") {
      return { text: "The Chrome companion sent an unexpected reply.", isError: true };
    }
    const copied = copyCapture(msg.path, cwd, tabId);
    if (!copied) return { text: "The Chrome companion did not return a capture file.", isError: true };
    const title = typeof msg.title === "string" ? msg.title : "";
    const url = typeof msg.url === "string" ? msg.url : "";
    return { text: formatCapture({ title, url, path: copied.rel }), isError: false, image: copied.bytes };
  } catch (err) {
    return { text: thrownText(err), isError: true };
  }
}
