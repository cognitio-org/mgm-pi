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
  kernalSocketPath,
  kernalStateDir,
  NativeFrameDecoder,
  replyToLine,
  replyToMessage,
  socketPathFrom,
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
  const readFile = () => { throw new Error("ENOENT"); };
  assert.equal(kernalHomeFrom(installed, { env: {}, home: "/home/person", exists, readFile }), "/tmp/example/.kernal");
  assert.equal(
    kernalHomeFrom(installed, { env: { KERNAL_HOME: "/custom" }, home: "/home/person", exists, readFile }),
    "/custom",
  );
  const repo = "/src/mgm-pi/chrome/host/kernal-chrome-host.mjs";
  const repoExists = (p) => p === "/src/mgm-pi/kernal" || p === "/src/mgm-pi/state";
  assert.equal(kernalHomeFrom(repo, { env: {}, home: "/home/person", exists: repoExists, readFile }), "/home/person/.kernal");
});

test("a state dir outside the home still yields the socket path kernal opens", () => {
  const hostFile = "/opt/kernal/chrome/host/kernal-chrome-host.mjs";
  const record = "/opt/kernal/chrome/host/socket-path";
  const state = "/var/kernal-state";
  const envForKernal = { KERNAL_HOME: "/opt/kernal", KERNAL_STATE: state, MGM_STATE: "/legacy/state" };
  const expected = kernalSocketPath(envForKernal, "/home/person");
  assert.equal(expected, "/opt/kernal/chrome.sock");
  assert.equal(kernalStateDir(envForKernal, "/home/person"), state);
  assert.notEqual(expected, join(state, "chrome.sock"));
  // Legacy default MGM_HOME is the install being migrated, not the target.
  assert.equal(
    kernalSocketPath({ MGM_HOME: "/home/person/.mgm", KERNAL_STATE: state }, "/home/person"),
    "/home/person/.kernal/chrome.sock",
  );
  assert.equal(
    kernalSocketPath({ MGM_HOME: "/custom/mgm", MGM_STATE: state }, "/home/person"),
    "/custom/mgm/chrome.sock",
  );

  // Chrome's environment has neither variable. The install record is the path.
  // A sibling kernal/ directory would otherwise look like the repo and fall back.
  const exists = (p) => p === state || p === "/opt/kernal/kernal";
  const readFile = (p) => {
    if (p !== record) throw new Error(`unexpected read ${p}`);
    return `${expected}\n`;
  };
  assert.equal(socketPathFrom(hostFile, { env: {}, home: "/home/person", exists, readFile }), expected);
  assert.equal(
    socketPathFrom(hostFile, { env: { KERNAL_HOME: "/somewhere/else" }, home: "/home/person", exists, readFile }),
    expected,
  );

  // No record yet: <home>/state is absent, and that must not select ~/.kernal.
  const readMissing = () => { throw new Error("ENOENT"); };
  const noRepo = (p) => p === state;
  assert.equal(socketPathFrom(hostFile, { env: {}, home: "/home/person", exists: noRepo, readFile: readMissing }), expected);
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

test("two hosts: shutting down the loser leaves the survivor accepting list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kernal-chrome-host-"));
  const sockPath = join(dir, "chrome.sock");
  const spawnHost = () => spawn(process.execPath, [host], {
    env: { ...process.env, KERNAL_HOME: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const first = spawnHost();
  let second;
  try {
    await waitFor(first, first.stderr, "listening");
    second = spawnHost();
    await waitFor(second, second.stderr, "socket in use");
    assert.equal(second.exitCode, null);
    assert.deepEqual(JSON.parse(await sendLine(sockPath, '{"t":"list"}\n')), { t: "shares", shares: [] });

    second.kill("SIGTERM");
    const [loserCode] = await once(second, "exit");
    assert.equal(loserCode, 0);
    assert.equal(first.exitCode, null);
    assert.deepEqual(JSON.parse(await sendLine(sockPath, '{"t":"list"}\n')), { t: "shares", shares: [] });
  } finally {
    await stop(first);
    if (second) await stop(second);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a leftover socket with nobody listening is replaced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kernal-chrome-host-"));
  const sockPath = join(dir, "chrome.sock");
  // SIGKILL skips the close handler, so the socket file stays and nothing accepts it.
  const holder = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createServer } from "node:net";
    const server = createServer();
    server.listen(process.env.SOCK, () => process.stdout.write("up\\n"));
    setInterval(() => {}, 1000);
  `], {
    env: { ...process.env, SOCK: sockPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let proc;
  try {
    await waitFor(holder, holder.stdout, "up");
    holder.kill("SIGKILL");
    await once(holder, "exit");
    assert.equal(existsSync(sockPath), true);
    proc = spawn(process.execPath, [host], {
      env: { ...process.env, KERNAL_HOME: dir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    await waitFor(proc, proc.stderr, "listening");
    assert.deepEqual(JSON.parse(await sendLine(sockPath, '{"t":"list"}\n')), { t: "shares", shares: [] });
  } finally {
    if (holder.exitCode === null) holder.kill("SIGKILL");
    if (proc) await stop(proc);
    rmSync(dir, { recursive: true, force: true });
  }
});
