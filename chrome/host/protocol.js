// Native-messaging frames and the unix-socket lines the Chrome host speaks.
// No Chrome APIs. The host and node:test both import this file.
//
// Chrome's frame is a 4-byte little-endian length, then that many JSON bytes.
// The socket is one JSON object per line. Share and capture are wired to the
// extension later; until then the share list is empty and every capture is refused.

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

/** Reply for one already-parsed message. Capture is refused: nothing is shared yet. */
export function replyToMessage(message) {
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    return { t: "error", error: "rejected" };
  }
  if (message.t === "list") return { t: "shares", shares: [] };
  if (message.t === "capture") return { t: "error", error: "tab is not shared" };
  return { t: "error", error: "rejected" };
}

/** One socket line. Blank lines are ignored. Anything that is not JSON is an error line. */
export function replyToLine(line) {
  if (typeof line !== "string") return { t: "error", error: "invalid json" };
  const trimmed = line.trim();
  if (trimmed === "") return null;
  try {
    return replyToMessage(JSON.parse(trimmed));
  } catch {
    return { t: "error", error: "invalid json" };
  }
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
