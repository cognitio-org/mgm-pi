#!/usr/bin/env node
// Chrome starts this process for com.kernal.chrome. stdout is reserved for
// native-messaging frames; logs go to stderr. The unix socket is how Kernal
// talks to the host. Capture is refused until a tab is actually shared.

import { chmodSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeNativeMessage, kernalHomeFrom, NativeFrameDecoder, replyToLine, replyToMessage } from "./protocol.js";

const home = kernalHomeFrom(fileURLToPath(import.meta.url));
const sockPath = join(home, "chrome.sock");
const sockets = new Set();
let shuttingDown = false;

mkdirSync(home, { recursive: true });
try {
  unlinkSync(sockPath);
} catch (err) {
  if (err.code !== "ENOENT") {
    process.stderr.write(`kernal-chrome-host: ${err.message}\n`);
    process.exit(1);
  }
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const socket of sockets) socket.destroy();
  server.close();
  try { unlinkSync(sockPath); } catch { /* already gone */ }
  process.exit(0);
}

const server = createServer((socket) => {
  sockets.add(socket);
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    if (buf.length > 1024 * 1024) {
      buf = "";
      socket.write(`${JSON.stringify({ t: "error", error: "rejected" })}\n`);
      return;
    }
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const reply = replyToLine(line);
      if (reply) socket.write(`${JSON.stringify(reply)}\n`);
    }
  });
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => sockets.delete(socket));
});

const prevUmask = process.umask(0o177);
server.on("error", (err) => {
  process.umask(prevUmask);
  process.stderr.write(`kernal-chrome-host: ${err.message}\n`);
  process.exit(1);
});
server.listen(sockPath, () => {
  process.umask(prevUmask);
  try { chmodSync(sockPath, 0o600); } catch (err) {
    process.stderr.write(`kernal-chrome-host: chmod ${err.message}\n`);
  }
  process.stderr.write("kernal-chrome-host: listening\n");
});

const decoder = new NativeFrameDecoder();
process.stdin.on("data", (chunk) => {
  let messages;
  try {
    messages = decoder.push(chunk);
  } catch (err) {
    process.stderr.write(`kernal-chrome-host: ${err.message}\n`);
    return;
  }
  for (const message of messages) {
    // Only the messages this slice already speaks. Anything else would be a
    // guess at the extension protocol, which is a later change.
    if (!message || typeof message !== "object" || (message.t !== "list" && message.t !== "capture")) continue;
    process.stdout.write(encodeNativeMessage(replyToMessage(message)));
  }
});
process.stdin.on("end", shutdown);
process.stdin.on("error", shutdown);
process.stdout.on("error", (err) => {
  if (err.code === "EPIPE") shutdown();
});
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.resume();
