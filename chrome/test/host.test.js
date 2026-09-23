import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import {
  encodeNativeMessage,
  kernalHomeFrom,
  NativeFrameDecoder,
  replyToLine,
  replyToMessage,
} from "../host/protocol.js";

const host = fileURLToPath(new URL("../host/kernal-chrome-host.mjs", import.meta.url));

test("native frames are 4-byte little-endian lengths", () => {
  const buf = encodeNativeMessage({ t: "list" });
  const len = buf.length - 4;
  assert.equal(buf.readUInt32LE(0), len);
  assert.equal(buf[0], len & 0xff);
  assert.equal(buf[1], 0);
  assert.deepEqual(JSON.parse(buf.subarray(4).toString("utf8")), { t: "list" });
});

test("a decoder reassembles frames split across chunks and rejects an oversized length", () => {
  const first = encodeNativeMessage({ t: "list" });
  const second = encodeNativeMessage({ t: "capture", tabId: 4 });
  const decoder = new NativeFrameDecoder();
  let got = [];
  for (const byte of Buffer.concat([first, second])) {
    got = got.concat(decoder.push(Buffer.from([byte])));
  }
  assert.deepEqual(got, [{ t: "list" }, { t: "capture", tabId: 4 }]);

  const huge = Buffer.alloc(4);
  huge.writeUInt32LE(1024 * 1024 + 1, 0);
  assert.throws(() => new NativeFrameDecoder().push(huge), /too large/);
});

test("list is an empty share list and capture is refused", () => {
  assert.deepEqual(replyToMessage({ t: "list" }), { t: "shares", shares: [] });
  assert.deepEqual(replyToMessage({ t: "list", extra: true }), { t: "shares", shares: [] });
  assert.deepEqual(replyToMessage({ t: "capture", tabId: 3 }), { t: "error", error: "tab is not shared" });
  assert.deepEqual(replyToMessage({ t: "capture" }), { t: "error", error: "tab is not shared" });
  assert.deepEqual(replyToMessage({ t: "share" }), { t: "error", error: "rejected" });
  assert.deepEqual(replyToMessage(null), { t: "error", error: "rejected" });
  assert.equal(replyToLine("\n"), null);
  assert.deepEqual(replyToLine('{"t":"list"}\n'), { t: "shares", shares: [] });
  assert.deepEqual(replyToLine("not json"), { t: "error", error: "invalid json" });
});

test("the socket lives under an install root, or ~/.kernal when this file is the repo copy", () => {
  const installed = "/tmp/example/.kernal/chrome/host/kernal-chrome-host.mjs";
  const exists = (p) => p === "/tmp/example/.kernal/state";
  assert.equal(kernalHomeFrom(installed, { env: {}, home: "/home/person", exists }), "/tmp/example/.kernal");
  assert.equal(
    kernalHomeFrom(installed, { env: { KERNAL_HOME: "/custom" }, home: "/home/person", exists }),
    "/custom",
  );
  const repo = "/src/mgm-pi/chrome/host/kernal-chrome-host.mjs";
  const repoExists = (p) => p === "/src/mgm-pi/kernal" || p === "/src/mgm-pi/state";
  assert.equal(kernalHomeFrom(repo, { env: {}, home: "/home/person", exists: repoExists }), "/home/person/.kernal");
});

function waitFor(proc, stream, text) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${text}: ${buf}`)), 4000);
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes(text)) {
        clearTimeout(timer);
        stream.off("data", onData);
        resolve(buf);
      }
    };
    stream.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`exited ${code} before ${text}: ${buf}`));
    });
  });
}

function readFrame(proc) {
  const decoder = new NativeFrameDecoder();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("frame timeout")), 4000);
    const onData = (chunk) => {
      let messages;
      try {
        messages = decoder.push(chunk);
      } catch (err) {
        clearTimeout(timer);
        proc.stdout.off("data", onData);
        reject(err);
        return;
      }
      if (messages.length > 0) {
        clearTimeout(timer);
        proc.stdout.off("data", onData);
        resolve(messages[0]);
      }
    };
    proc.stdout.on("data", onData);
  });
}

function sendLine(sockPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    let buf = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`socket timeout, got ${JSON.stringify(buf)}`));
    }, 4000);
    socket.on("error", (err) => { clearTimeout(timer); reject(err); });
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      if (buf.includes("\n")) {
        clearTimeout(timer);
        socket.end();
        resolve(buf);
      }
    });
    socket.on("connect", () => {
      const mid = Math.max(1, Math.floor(payload.length / 2));
      socket.write(payload.slice(0, mid));
      socket.write(payload.slice(mid));
    });
  });
}

async function stop(proc) {
  if (proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  await Promise.race([once(proc, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
  if (proc.exitCode === null) proc.kill("SIGKILL");
}

test("the host socket lists no shares, refuses capture, and speaks native frames", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kernal-chrome-host-"));
  const sockPath = join(dir, "chrome.sock");
  const proc = spawn(process.execPath, [host], {
    env: { ...process.env, KERNAL_HOME: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    await waitFor(proc, proc.stderr, "listening");
    assert.equal(statSync(sockPath).mode & 0o777, 0o600);
    const listed = await sendLine(sockPath, '{"t":"list"}\n');
    assert.equal(listed.trim().split("\n").length, 1);
    assert.deepEqual(JSON.parse(listed), { t: "shares", shares: [] });
    assert.deepEqual(JSON.parse(await sendLine(sockPath, '{"t":"capture","tabId":7}\n')), {
      t: "error",
      error: "tab is not shared",
    });

    const frame = readFrame(proc);
    const body = Buffer.from(JSON.stringify({ t: "capture", tabId: 7 }));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    proc.stdin.write(header.subarray(0, 2));
    proc.stdin.write(Buffer.concat([header.subarray(2), body]));
    assert.deepEqual(await frame, { t: "error", error: "tab is not shared" });

    const listedFrame = readFrame(proc);
    proc.stdin.write(encodeNativeMessage({ t: "list" }));
    assert.deepEqual(await listedFrame, { t: "shares", shares: [] });

    proc.stdin.end();
    const [code] = await once(proc, "exit");
    assert.equal(code, 0);
    assert.equal(existsSync(sockPath), false);
  } finally {
    await stop(proc);
    rmSync(dir, { recursive: true, force: true });
  }
});
