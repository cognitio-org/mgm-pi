// Native-messaging frames and the unix-socket lines the Chrome host speaks.
// No Chrome APIs. The host and node:test both import this file.
//
// Chrome's frame is a 4-byte little-endian length, then that many JSON bytes.
// The socket is one JSON object per line. Share and capture are wired to the
// extension later; until then the share list is empty and every capture is refused.

import { existsSync } from "node:fs";
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

/**
 * Where the host listens. KERNAL_HOME wins. An installed copy lives at
 * `<home>/chrome/host` next to `<home>/state` and not next to a `kernal/`
 * directory (that layout is the repo). Anything else falls back to ~/.kernal,
 * which is the path the spec names.
 */
export function kernalHomeFrom(hostFile, options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const exists = options.exists ?? existsSync;
  if (typeof env.KERNAL_HOME === "string" && env.KERNAL_HOME !== "") return env.KERNAL_HOME;
  const chromeDir = dirname(dirname(hostFile));
  const root = dirname(chromeDir);
  if (basename(chromeDir) === "chrome" && exists(join(root, "state")) && !exists(join(root, "kernal"))) {
    return root;
  }
  return join(home, ".kernal");
}
