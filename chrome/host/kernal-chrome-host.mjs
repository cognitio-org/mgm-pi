#!/usr/bin/env node
// Chrome starts this process for com.kernal.chrome. stdout is reserved for
// native-messaging frames; logs go to stderr. The unix socket is how Kernal
// talks to the host. Capture is refused until a tab is actually shared.
//
// Each connectNative() starts a process. Only the one that bound the socket
// unlinks it, and only while that socket is still the inode it bound.

import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeNativeMessage, socketPathFrom, NativeFrameDecoder, replyToLine, replyToMessage } from "./protocol.js";

const sockPath = socketPathFrom(fileURLToPath(import.meta.url));
const sockets = new Set();
let shuttingDown = false;
let owns = null;
let reclaimed = false;

mkdirSync(dirname(sockPath), { recursive: true });

function unlinkOwned() {
  if (!owns) return;
  try {
    const st = lstatSync(sockPath);
    if (st.dev !== owns.dev || st.ino !== owns.ino) return;
    unlinkSync(sockPath);
  } catch {
    /* already gone, or replaced by a socket we did not bind */
  }
  owns = null;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const socket of sockets) socket.destroy();
  server.close();
  unlinkOwned();
  process.exit(0);
}

// "live" if anything accepts the path. A refused or missing socket is stale.
function probe(path) {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish("live"), 250);
    socket.on("connect", () => {
      socket.write('{"t":"list"}\n');
      finish("live");
    });
    socket.on("error", (err) => {
      finish(err.code === "ECONNREFUSED" || err.code === "ENOENT" ? "dead" : "live");
    });
  });
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

let mask = process.umask(0o177);

function onListening() {
  process.umask(mask);
  try {
    const st = lstatSync(sockPath);
    owns = { dev: st.dev, ino: st.ino };
  } catch {
    owns = null;
  }
  try { chmodSync(sockPath, 0o600); } catch (err) {
    process.stderr.write(`kernal-chrome-host: chmod ${err.message}\n`);
  }
  process.stderr.write("kernal-chrome-host: listening\n");
}

server.on("error", (err) => {
  if (shuttingDown) return;
  process.umask(mask);
  if (err.code !== "EADDRINUSE") {
    process.stderr.write(`kernal-chrome-host: ${err.message}\n`);
    process.exit(1);
  }
  probe(sockPath).then((state) => {
    if (shuttingDown) return;
    // In use: leave it. This process still answers Chrome on stdin, but it
    // did not bind, so shutdown must not unlink the live socket.
    if (state === "live" || reclaimed) {
      process.stderr.write("kernal-chrome-host: socket in use\n");
      return;
    }
    reclaimed = true;
    try {
      unlinkSync(sockPath);
    } catch (e) {
      if (e.code !== "ENOENT") {
        process.stderr.write(`kernal-chrome-host: ${e.message}\n`);
        process.exit(1);
      }
    }
    mask = process.umask(0o177);
    server.listen(sockPath, onListening);
  });
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
server.listen(sockPath, onListening);
