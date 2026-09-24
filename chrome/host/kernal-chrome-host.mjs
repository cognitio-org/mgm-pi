#!/usr/bin/env node
// Chrome starts this process for com.kernal.chrome. stdout is reserved for
// native-messaging frames; logs go to stderr. The unix socket is how Kernal
// talks to the host. Stdin is the extension: it announces shares and answers
// capture or an action. The socket only lists those shares and asks for one.
//
// Each connectNative() starts a process. Only the one that bound the socket
// unlinks it, and only while that socket is still the inode it bound.

import { chmodSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyExtensionMessage,
  captureJpegPath,
  decideSocketLine,
  encodeNativeMessage,
  ERR_CAPTURE_FAILED,
  ERR_CAPTURE_TIMEOUT,
  ERR_NOT_CONNECTED,
  jpegBytes,
  NativeFrameDecoder,
  socketPathFrom,
} from "./protocol.js";

const CAPTURE_TIMEOUT_MS = 15000;
// Tests set KERNAL_CHROME_ACTION_TIMEOUT_MS. An unanswered confirm otherwise waits 90s.
const ACTION_TIMEOUT_MS = readTimeoutMs(process.env.KERNAL_CHROME_ACTION_TIMEOUT_MS, 90000);

const sockPath = socketPathFrom(fileURLToPath(import.meta.url));
const sockets = new Set();
let shuttingDown = false;
let owns = null;
let reclaimed = false;
let shares = [];
let extensionConnected = true;
let nextId = 1;
// The in-flight request a timeout already answered. A late reply with this id is
// dropped. It does not stop the queue; disconnect clears it.
let abandoned = null;
const waiters = [];

function readTimeoutMs(value, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 600000) return fallback;
  return parsed;
}

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

function writeLine(socket, message) {
  if (!socket || socket.destroyed) return;
  socket.write(`${JSON.stringify(message)}\n`);
}

function broadcast(message) {
  if (!message) return;
  const waiting = new Set(waiters.map((waiter) => waiter.socket).filter(Boolean));
  const line = `${JSON.stringify(message)}\n`;
  for (const socket of sockets) {
    if (socket.destroyed || waiting.has(socket)) continue;
    socket.write(line);
  }
}

function writeJpeg(tabId, bytes) {
  const path = captureJpegPath(dirname(sockPath), tabId);
  if (!path) return null;
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, bytes, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    chmodSync(path, 0o600);
    return path;
  } catch {
    try { unlinkSync(tmp); } catch { /* nothing was written */ }
    return null;
  }
}

function dropWaiter(waiter) {
  if (waiter.timer) clearTimeout(waiter.timer);
  const index = waiters.indexOf(waiter);
  if (index !== -1) waiters.splice(index, 1);
}

function waiterKind(waiter) {
  return waiter?.forward?.t === "action" ? "action" : "capture";
}

function carriedId(value) {
  return Number.isInteger(value?.id) && value.id > 0 ? value.id : null;
}

function pump() {
  if (shuttingDown || !extensionConnected) return;
  const head = waiters[0];
  if (!head || head.sent) return;
  head.sent = true;
  head.id = nextId++;
  const timeoutMs = head.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  const timeoutError = waiterKind(head) === "action" ? "action timed out" : ERR_CAPTURE_TIMEOUT;
  head.timer = setTimeout(() => {
    if (shuttingDown || !waiters.includes(head)) return;
    abandonInFlight(head, timeoutError);
  }, timeoutMs);
  let frame;
  try {
    frame = encodeNativeMessage({ ...(head.forward ?? { t: "capture", tabId: head.tabId }), id: head.id });
  } catch {
    dropWaiter(head);
    writeLine(head.socket, { t: "error", error: ERR_NOT_CONNECTED });
    pump();
    return;
  }
  try {
    process.stdout.write(frame);
  } catch {
    // The extension pipe is gone. Fail the queue now; a later stdin message
    // means it reconnected and new requests can be served.
    markExtensionDisconnected();
  }
}

function markExtensionDisconnected() {
  if (shuttingDown) return;
  extensionConnected = false;
  abandoned = null;
  const pending = waiters.splice(0);
  for (const waiter of pending) {
    if (waiter.timer) clearTimeout(waiter.timer);
    writeLine(waiter.socket, { t: "error", error: ERR_NOT_CONNECTED });
  }
}

function abandonInFlight(waiter, error) {
  abandoned = { id: waiter.id, kind: waiterKind(waiter), tabId: waiter.tabId };
  dropWaiter(waiter);
  writeLine(waiter.socket, { t: "error", error });
  pump();
}

function replyFitsHead(kind, head, result) {
  if (kind !== "action") return true;
  return result.tabId === head.tabId;
}

// A reply whose id is the abandoned request is dropped, even when a new waiter
// is already at the head. An id for that head is applied. An untagged reply is
// the abandoned one only when it does not fit the head.
function discardIfAbandoned(kind, result) {
  if (!abandoned) return false;
  const id = carriedId(result);
  if (id !== null) {
    if (id !== abandoned.id) return false;
    abandoned = null;
    return true;
  }
  if (abandoned.kind !== kind) return false;
  const head = waiters[0];
  if (head && head.sent && waiterKind(head) === kind && replyFitsHead(kind, head, result)) return false;
  abandoned = null;
  return true;
}

function enqueueCapture(socket, tabId) {
  if (!extensionConnected || shuttingDown) {
    writeLine(socket, { t: "error", error: ERR_NOT_CONNECTED });
    return;
  }
  waiters.push({ tabId, socket, sent: false, timer: null });
  pump();
}

function enqueueAction(socket, forward) {
  if (!extensionConnected || shuttingDown) {
    writeLine(socket, { t: "error", error: ERR_NOT_CONNECTED });
    return;
  }
  waiters.push({ tabId: forward.tabId, forward, socket, sent: false, timer: null, timeoutMs: ACTION_TIMEOUT_MS });
  pump();
}

function settleAction(action) {
  if (discardIfAbandoned("action", action)) return;
  const head = waiters[0];
  if (!head || !head.sent || waiterKind(head) !== "action") return;
  const id = carriedId(action);
  if (id !== null && id !== head.id) return;
  if (action.tabId !== head.tabId) return;
  dropWaiter(head);
  if (action.kind === "error") writeLine(head.socket, { t: "error", error: action.error });
  else writeLine(head.socket, { t: "acted", tabId: action.tabId });
  pump();
}

function settleCapture(capture) {
  if (discardIfAbandoned("capture", capture)) return;
  const head = waiters[0];
  if (!head || !head.sent || waiterKind(head) !== "capture") return;
  const id = carriedId(capture);
  if (id !== null && id !== head.id) return;
  dropWaiter(head);
  if (capture.kind === "error") {
    writeLine(head.socket, { t: "error", error: capture.error });
    pump();
    return;
  }
  if (capture.tabId !== head.tabId) {
    writeLine(head.socket, { t: "error", error: ERR_CAPTURE_FAILED });
    pump();
    return;
  }
  const bytes = jpegBytes(capture.jpegBase64);
  const path = bytes ? writeJpeg(capture.tabId, bytes) : null;
  if (!path) writeLine(head.socket, { t: "error", error: ERR_CAPTURE_FAILED });
  else writeLine(head.socket, { t: "captured", tabId: capture.tabId, title: capture.title, url: capture.url, path });
  pump();
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  extensionConnected = false;
  // Disconnect forgets the abandoned id and fails the queue. The next
  // connectNative is a new process and can serve new requests.
  abandoned = null;
  const pending = waiters.splice(0);
  let left = 0;
  const finish = () => {
    if (left > 0) return;
    for (const socket of sockets) socket.destroy();
    server.close();
    unlinkOwned();
    process.exit(0);
  };
  for (const waiter of pending) {
    if (waiter.timer) clearTimeout(waiter.timer);
    if (!waiter.socket || waiter.socket.destroyed) continue;
    left += 1;
    waiter.socket.write(`${JSON.stringify({ t: "error", error: ERR_NOT_CONNECTED })}\n`, () => {
      left -= 1;
      finish();
    });
  }
  finish();
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
      const decision = decideSocketLine(line, { shares, extensionConnected });
      if (!decision) continue;
      if (decision.forward) {
        if (decision.forward.t === "action") enqueueAction(socket, decision.forward);
        else enqueueCapture(socket, decision.forward.tabId);
        continue;
      }
      writeLine(socket, decision.reply);
    }
  });
  const drop = () => {
    sockets.delete(socket);
    const index = waiters.findIndex((waiter) => waiter.socket === socket);
    if (index < 0) return;
    const waiter = waiters[index];
    if (index === 0 && waiter.sent) {
      waiter.socket = null;
      return;
    }
    dropWaiter(waiter);
  };
  socket.on("close", drop);
  socket.on("error", drop);
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
  if (!shuttingDown && !extensionConnected) extensionConnected = true;
  let messages;
  try {
    messages = decoder.push(chunk);
  } catch (err) {
    process.stderr.write(`kernal-chrome-host: ${err.message}\n`);
    return;
  }
  for (const message of messages) {
    const applied = applyExtensionMessage(shares, message);
    shares = applied.shares;
    broadcast(applied.broadcast);
    if (applied.action) settleAction(applied.action);
    if (applied.capture) settleCapture(applied.capture);
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
