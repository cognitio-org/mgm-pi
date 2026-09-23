// Native-messaging frames and the unix-socket lines the Chrome host speaks.
// No Chrome APIs. The host and node:test both import this file.
//
// Chrome's frame is a 4-byte little-endian length, then that many JSON bytes.
// The socket is one JSON object per line. Stdin is the extension (share,
// unshare, captured, error). The socket is Kernal (list, capture).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const MAX_NATIVE_MESSAGE = 1024 * 1024;

export function encodeNativeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_NATIVE_MESSAGE) throw new Error("native message too large");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Bytes in, complete JSON messages out. An incomplete frame stays buffered. */
export class NativeFrameDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buf = this.buf.length === 0 ? next : Buffer.concat([this.buf, next]);
    const messages = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32LE(0);
      if (len > MAX_NATIVE_MESSAGE) throw new Error("native message too large");
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = Buffer.from(this.buf.subarray(4 + len));
      try {
        messages.push(JSON.parse(body.toString("utf8")));
      } catch {
        throw new Error("native message is not json");
      }
    }
    return messages;
  }
}

export const ERR_NOT_SHARED = "tab is not shared";
export const ERR_NOT_CONNECTED = "not connected";
export const ERR_REJECTED = "rejected";
export const ERR_CAPTURE_FAILED = "capture failed";
export const ERR_CAPTURE_TIMEOUT = "capture timed out";

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

function copyShares(shares) {
  if (!Array.isArray(shares)) return [];
  return shares.map((share) => ({
    tabId: share.tabId,
    title: share.title,
    url: share.url,
    sessionId: share.sessionId,
  }));
}

/** Tab ids the extension has shared. A socket client cannot add one. */
export function tabIsShared(shares, tabId) {
  return Number.isInteger(tabId) && tabId >= 0 && copyShares(shares).some((share) => share.tabId === tabId);
}

/**
 * One socket message from Kernal.
 * `reply` is written back as a line. `forward` is a capture the host must send
 * to the extension; the socket stays unanswered until `captured` or `error`.
 * A share on the socket is rejected: only the extension can add a share.
 */
export function decideSocketMessage(message, state = {}) {
  const shares = copyShares(state.shares);
  const connected = state.extensionConnected !== false;
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return { reply: { t: "error", error: ERR_REJECTED } };
  }
  if (message.t === "list") return { reply: { t: "shares", shares } };
  if (message.t === "capture") {
    if (!tabIsShared(shares, message.tabId)) return { reply: { t: "error", error: ERR_NOT_SHARED } };
    if (!connected) return { reply: { t: "error", error: ERR_NOT_CONNECTED } };
    return { forward: { t: "capture", tabId: message.tabId } };
  }
  return { reply: { t: "error", error: ERR_REJECTED } };
}

/** Immediate socket reply, or null when the line is blank or the host must ask Chrome. */
export function replyToMessage(message, state) {
  return decideSocketMessage(message, state).reply ?? null;
}

/** One socket line. Blank lines are ignored. Anything that is not JSON is an error line. */
export function decideSocketLine(line, state) {
  if (typeof line !== "string") return { reply: { t: "error", error: "invalid json" } };
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    return decideSocketMessage(JSON.parse(trimmed), state);
  } catch {
    return { reply: { t: "error", error: "invalid json" } };
  }
}

export function replyToLine(line, state) {
  const decision = decideSocketLine(line, state);
  if (!decision) return null;
  return decision.reply ?? null;
}

function shareFromExtension(message) {
  if (!Number.isInteger(message.tabId) || message.tabId < 0) return null;
  if (typeof message.title !== "string" || typeof message.url !== "string") return null;
  if (typeof message.sessionId !== "string" || !SESSION_ID.test(message.sessionId)) return null;
  return { tabId: message.tabId, title: message.title, url: message.url, sessionId: message.sessionId };
}

/** Extension error strings the socket client should see. `not_shared` matches the local refusal. */
export function captureErrorText(error) {
  if (error === "not_shared" || error === ERR_NOT_SHARED) return ERR_NOT_SHARED;
  if (typeof error !== "string" || error === "") return ERR_CAPTURE_FAILED;
  return error;
}

/**
 * One native message from the extension. Shares are remembered and dropped here.
 * `broadcast` is an unsolicited line for socket clients. `capture` settles the
 * in-flight capture. List and capture from stdin are ignored: Kernal sends those.
 */
export function applyExtensionMessage(shares, message) {
  const current = copyShares(shares);
  const keep = { shares: current, broadcast: null, capture: null };
  if (message === null || typeof message !== "object" || Array.isArray(message)) return keep;
  if (message.t === "share") {
    const share = shareFromExtension(message);
    if (!share) return keep;
    const next = current.filter((item) => item.sessionId !== share.sessionId);
    next.push(share);
    return { shares: next, broadcast: { t: "share", ...share }, capture: null };
  }
  if (message.t === "unshare") {
    if (!Number.isInteger(message.tabId)) return keep;
    const next = current.filter((item) => item.tabId !== message.tabId);
    if (next.length === current.length) return keep;
    return { shares: next, broadcast: { t: "unshare", tabId: message.tabId }, capture: null };
  }
  if (message.t === "captured") {
    if (!Number.isInteger(message.tabId) || message.tabId < 0) {
      return { shares: current, broadcast: null, capture: { kind: "error", error: ERR_CAPTURE_FAILED } };
    }
    return {
      shares: current,
      broadcast: null,
      capture: {
        kind: "jpeg",
        tabId: message.tabId,
        title: typeof message.title === "string" ? message.title : "",
        url: typeof message.url === "string" ? message.url : "",
        jpegBase64: typeof message.jpegBase64 === "string" ? message.jpegBase64 : "",
      },
    };
  }
  if (message.t === "error") {
    return {
      shares: current,
      broadcast: null,
      capture: { kind: "error", error: captureErrorText(message.error) },
    };
  }
  return keep;
}

/** Decode a jpeg the extension sent, or null when it is not a jpeg. */
export function jpegBytes(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s/g, "");
  if (cleaned.length === 0 || cleaned.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) return null;
  const buf = Buffer.from(cleaned, "base64");
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  return buf;
}

/** `<home>/chrome/captures/<tabId>.jpg`. One file per tab; a later capture overwrites it. */
export function captureJpegPath(home, tabId) {
  if (typeof home !== "string" || home === "") return null;
  if (!Number.isInteger(tabId) || tabId < 0) return null;
  return join(home, "chrome", "captures", `${tabId}.jpg`);
}

const SOCKET_NAME = "chrome.sock";
// Written by install.sh next to the host. Chrome execs the host with a clean
// environment, so KERNAL_HOME and KERNAL_STATE from the shell are not there.
const SOCKET_RECORD = "socket-path";

/** install.sh's HOME_DIR: KERNAL_HOME, else a non-default MGM_HOME, else none. */
function explicitHome(env, osHome) {
  if (typeof env.KERNAL_HOME === "string" && env.KERNAL_HOME !== "") return env.KERNAL_HOME;
  const legacy = join(osHome, ".mgm");
  if (typeof env.MGM_HOME === "string" && env.MGM_HOME !== "" && env.MGM_HOME !== legacy) return env.MGM_HOME;
  return null;
}

/**
 * State directory the installer calls STATE. KERNAL_STATE, else MGM_STATE, else
 * `<home>/state`. This may sit outside the home. It is not where the socket lives:
 * a missing `<home>/state` is still a valid install.
 */
export function kernalStateDir(env, osHome) {
  const home = explicitHome(env, osHome) ?? join(osHome, ".kernal");
  if (typeof env.KERNAL_STATE === "string" && env.KERNAL_STATE !== "") return env.KERNAL_STATE;
  if (typeof env.MGM_STATE === "string" && env.MGM_STATE !== "") return env.MGM_STATE;
  return join(home, "state");
}

/** `<home>/chrome.sock` — the path the running kernal opens. STATE does not move it. */
export function kernalSocketPath(env, osHome) {
  const home = explicitHome(env, osHome) ?? join(osHome, ".kernal");
  return join(home, SOCKET_NAME);
}

function recordedSocket(hostFile, readFile) {
  let text;
  try {
    text = readFile(join(dirname(hostFile), SOCKET_RECORD), "utf8");
  } catch {
    return null;
  }
  const line = String(text).trim();
  if (!line.startsWith("/") || basename(line) !== SOCKET_NAME) return null;
  return line;
}

/**
 * Where this host listens. The install record wins: it is the absolute socket
 * path install.sh wrote from the same home kernal uses, and it does not depend
 * on the shell environment or on `<home>/state` existing. Env and the on-disk
 * layout are fallbacks for a checkout, which has no record. A repo tree has a
 * `kernal/` directory beside `chrome/`; that is not an install, so it uses ~/.kernal.
 */
export function socketPathFrom(hostFile, options = {}) {
  const env = options.env ?? process.env;
  const osHome = options.home ?? homedir();
  const exists = options.exists ?? existsSync;
  const readFile = options.readFile ?? ((file) => readFileSync(file, "utf8"));
  const recorded = recordedSocket(hostFile, readFile);
  if (recorded) return recorded;
  const fromEnv = explicitHome(env, osHome);
  if (fromEnv) return join(fromEnv, SOCKET_NAME);
  const chromeDir = dirname(dirname(hostFile));
  const root = dirname(chromeDir);
  if (basename(chromeDir) === "chrome" && !exists(join(root, "kernal"))) return join(root, SOCKET_NAME);
  return join(osHome, ".kernal", SOCKET_NAME);
}

/** Directory that contains the socket. */
export function kernalHomeFrom(hostFile, options = {}) {
  return dirname(socketPathFrom(hostFile, options));
}
