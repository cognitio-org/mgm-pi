import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import {
  applyExtensionMessage,
  captureJpegPath,
  decideSocketMessage,
  redactHeaderText,
  encodeNativeMessage,
  jpegBytes,
  kernalHomeFrom,
  kernalSocketPath,
  kernalStateDir,
  NativeFrameDecoder,
  replyToLine,
  replyToMessage,
  socketPathFrom,
} from "../host/protocol.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const JPEG_B64 = JPEG.toString("base64");
const SHARE = { t: "share", tabId: 4, title: "Spec", url: "https://example.com/a", sessionId: "floppy-1" };

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

test("a share is remembered from the extension, and a socket cannot invent one", () => {
  const shared = applyExtensionMessage([], SHARE);
  assert.deepEqual(shared.shares, [{ tabId: 4, title: "Spec", url: "https://example.com/a", sessionId: "floppy-1" }]);
  assert.deepEqual(shared.broadcast, { t: "share", tabId: 4, title: "Spec", url: "https://example.com/a", sessionId: "floppy-1" });
  const again = applyExtensionMessage(shared.shares, { ...SHARE, title: "Renamed" });
  assert.equal(again.shares.length, 1);
  assert.equal(again.shares[0].title, "Renamed");
  const dropped = applyExtensionMessage(again.shares, { t: "unshare", tabId: 4 });
  assert.deepEqual(dropped.shares, []);
  assert.deepEqual(dropped.broadcast, { t: "unshare", tabId: 4 });
  assert.equal(applyExtensionMessage(dropped.shares, { t: "unshare", tabId: 4 }).broadcast, null);
  assert.deepEqual(applyExtensionMessage(shared.shares, { t: "list" }).shares, shared.shares);
  assert.equal(applyExtensionMessage([], { t: "share", tabId: 4, title: "x", url: "https://e", sessionId: "../x" }).shares.length, 0);

  const state = { shares: shared.shares, extensionConnected: true };
  assert.deepEqual(decideSocketMessage({ t: "list" }, state).reply.shares, shared.shares);
  assert.deepEqual(decideSocketMessage({ t: "capture", tabId: 9 }, state), { reply: { t: "error", error: "tab is not shared" } });
  assert.deepEqual(decideSocketMessage({ t: "capture", tabId: 4 }, state), { forward: { t: "capture", tabId: 4 } });
  assert.deepEqual(decideSocketMessage({ t: "capture", tabId: 4 }, { shares: shared.shares, extensionConnected: false }), {
    reply: { t: "error", error: "not connected" },
  });
  assert.deepEqual(decideSocketMessage({ t: "share", tabId: 1, title: "x", url: "https://e", sessionId: "abc" }), {
    reply: { t: "error", error: "rejected" },
  });
  assert.equal(replyToMessage({ t: "capture", tabId: 4 }, state), null);
  assert.deepEqual(decideSocketMessage({ t: "action", tabId: 9, kind: "click", selector: "#go" }, state), {
    reply: { t: "error", error: "tab is not shared" },
  });
  assert.deepEqual(decideSocketMessage({ t: "action", tabId: 4, kind: "click", selector: "javascript:alert(1)" }, state), {
    reply: { t: "error", error: "rejected" },
  });
  assert.deepEqual(decideSocketMessage({ t: "action", tabId: 4, kind: "click", selector: " #go " }, state), {
    forward: { t: "action", tabId: 4, kind: "click", selector: "#go" },
  });
  assert.equal(decideSocketMessage({ t: "action", tabId: 4, kind: "type", selector: "#q", text: "hi" }, state).forward.text, "hi");
  assert.deepEqual(decideSocketMessage({ t: "inspect", tabId: 9 }, state), { reply: { t: "error", error: "tab is not shared" } });
  assert.deepEqual(decideSocketMessage({ t: "inspect", tabId: 4, code: "x" }, state), { reply: { t: "error", error: "rejected" } });
  assert.deepEqual(decideSocketMessage({ t: "inspect", tabId: 4 }, state), { forward: { t: "inspect", tabId: 4 } });
});

test("jpeg bytes are the decoded image, one file per tab under the kernal home", () => {
  assert.deepEqual(jpegBytes(JPEG_B64), JPEG);
  assert.equal(jpegBytes("aaaa"), null);
  assert.equal(jpegBytes(""), null);
  assert.equal(captureJpegPath("/home/person/.kernal", 4), "/home/person/.kernal/chrome/captures/4.jpg");
  assert.equal(captureJpegPath("/home/person/.kernal", -1), null);
  const bad = applyExtensionMessage([], { t: "captured", tabId: 4, title: "Spec", url: "https://example.com/a", jpegBase64: "aaaa" });
  assert.equal(bad.capture.kind, "jpeg");
  assert.equal(jpegBytes(bad.capture.jpegBase64), null);
  assert.deepEqual(applyExtensionMessage([], { t: "error", error: "not_shared" }).capture, {
    kind: "error",
    error: "tab is not shared",
  });
  assert.deepEqual(applyExtensionMessage([], { t: "error", error: "permission_denied" }).capture, {
    kind: "error",
    error: "permission_denied",
  });
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

function holdLine(sockPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    let buf = "";
    socket.on("error", reject);
    socket.on("data", (chunk) => { buf += chunk.toString(); });
    socket.on("connect", () => {
      socket.write(payload);
      resolve({ socket, text: () => buf });
    });
  });
}

function sendLine(sockPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sockPath);
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`socket timeout, got ${JSON.stringify(buf)}`));
    }, 4000);
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    socket.on("error", fail);
    socket.on("data", (chunk) => {
      buf += chunk.toString();
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        // A share or unshare can land on this socket before the reply. It is not the reply.
        if (msg && (msg.t === "share" || msg.t === "unshare")) continue;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.end();
        resolve(`${line}\n`);
        return;
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

async function listedShares(sockPath, ready) {
  let last;
  for (let i = 0; i < 25; i++) {
    const raw = await sendLine(sockPath, '{"t":"list"}\n');
    last = JSON.parse(raw.trim().split("\n")[0]);
    if (last && Array.isArray(last.shares) && ready(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return last;
}

test("the host socket lists no shares and refuses capture without asking Chrome", async () => {
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
    let stdout = Buffer.alloc(0);
    proc.stdout.on("data", (chunk) => { stdout = Buffer.concat([stdout, chunk]); });
    assert.deepEqual(JSON.parse(await sendLine(sockPath, '{"t":"capture","tabId":7}\n')), {
      t: "error",
      error: "tab is not shared",
    });
    assert.equal(stdout.length, 0, "an unshared tab is refused without asking Chrome");
    assert.deepEqual(JSON.parse(await sendLine(sockPath, '{"t":"share","tabId":1,"title":"x","url":"https://e","sessionId":"abc"}\n')), {
      t: "error",
      error: "rejected",
    });

    proc.stdin.end();
    const [code] = await once(proc, "exit");
    assert.equal(code, 0);
    assert.equal(existsSync(sockPath), false);
  } finally {
    await stop(proc);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a shared tab is captured through the extension into one jpeg per tab", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kernal-chrome-host-"));
  const sockPath = join(dir, "chrome.sock");
  const proc = spawn(process.execPath, [host], {
    env: { ...process.env, KERNAL_HOME: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const share = (tabId, title) => proc.stdin.write(encodeNativeMessage({
    t: "share", tabId, title, url: `https://example.com/${tabId}`, sessionId: `floppy-${tabId}`,
  }));
  try {
    await waitFor(proc, proc.stderr, "listening");
    share(4, "Spec");
    const listed = await listedShares(sockPath, (msg) => msg.t === "shares" && msg.shares.length === 1);
    assert.deepEqual(listed.shares, [{ tabId: 4, title: "Spec", url: "https://example.com/4", sessionId: "floppy-4" }]);

    const badFrame = readFrame(proc);
    const badReply = sendLine(sockPath, '{"t":"capture","tabId":4}\n');
    assert.deepEqual(await badFrame, { t: "capture", tabId: 4, id: 1 });
    proc.stdin.write(encodeNativeMessage({ t: "captured", tabId: 4, title: "Spec", url: "https://example.com/4", jpegBase64: "aaaa" }));
    assert.deepEqual(JSON.parse(await badReply), { t: "error", error: "capture failed" });
    assert.equal(existsSync(join(dir, "chrome", "captures")), false);

    const deniedFrame = readFrame(proc);
    const deniedReply = sendLine(sockPath, '{"t":"capture","tabId":4}\n');
    assert.deepEqual(await deniedFrame, { t: "capture", tabId: 4, id: 2 });
    proc.stdin.write(encodeNativeMessage({ t: "error", error: "permission_denied" }));
    assert.deepEqual(JSON.parse(await deniedReply), { t: "error", error: "permission_denied" });

    const frame = readFrame(proc);
    const replyPromise = sendLine(sockPath, '{"t":"capture","tabId":4}\n');
    assert.deepEqual(await frame, { t: "capture", tabId: 4, id: 3 });
    proc.stdin.write(encodeNativeMessage({
      t: "captured", tabId: 4, title: "Spec", url: "https://example.com/4", jpegBase64: JPEG_B64,
    }));
    const reply = JSON.parse(await replyPromise);
    const path = join(dir, "chrome", "captures", "4.jpg");
    assert.deepEqual(reply, { t: "captured", tabId: 4, title: "Spec", url: "https://example.com/4", path });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readFileSync(path), JPEG);

    const again = readFrame(proc);
    const againReply = sendLine(sockPath, '{"t":"capture","tabId":4}\n');
    await again;
    proc.stdin.write(encodeNativeMessage({
      t: "captured", tabId: 4, title: "Spec", url: "https://example.com/4", jpegBase64: JPEG_B64,
    }));
    assert.equal(JSON.parse(await againReply).path, path);
    assert.deepEqual(readdirSync(join(dir, "chrome", "captures")).filter((name) => name.endsWith(".jpg")), ["4.jpg"]);

    share(8, "Other");
    await listedShares(sockPath, (msg) => msg.shares.some((share) => share.tabId === 8));
    const other = readFrame(proc);
    const otherReply = sendLine(sockPath, '{"t":"capture","tabId":8}\n');
    await other;
    proc.stdin.write(encodeNativeMessage({
      t: "captured", tabId: 8, title: "Other", url: "https://example.com/8", jpegBase64: JPEG_B64,
    }));
    assert.equal(JSON.parse(await otherReply).path, join(dir, "chrome", "captures", "8.jpg"));

    proc.stdin.write(encodeNativeMessage({ t: "unshare", tabId: 4 }));
    const after = await listedShares(sockPath, (msg) => !msg.shares.some((share) => share.tabId === 4));
    assert.equal(after.shares.some((share) => share.tabId === 8), true);
    assert.deepEqual(JSON.parse(await sendLine(sockPath, '{"t":"capture","tabId":4}\n')), {
      t: "error",
      error: "tab is not shared",
    });
  } finally {
    await stop(proc);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ending the extension connection fails an in-flight capture and unlinks the socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kernal-chrome-host-"));
  const sockPath = join(dir, "chrome.sock");
  const proc = spawn(process.execPath, [host], {
    env: { ...process.env, KERNAL_HOME: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    await waitFor(proc, proc.stderr, "listening");
    proc.stdin.write(encodeNativeMessage(SHARE));
    await listedShares(sockPath, (msg) => msg.shares.length === 1);
    const frame = readFrame(proc);
    const replyPromise = sendLine(sockPath, '{"t":"capture","tabId":4}\n');
    assert.deepEqual(await frame, { t: "capture", tabId: 4, id: 1 });
    proc.stdin.end();
    assert.deepEqual(JSON.parse(await replyPromise), { t: "error", error: "not connected" });
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

test("an unanswered action does not stall the next capture", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kernal-chrome-host-"));
  const sockPath = join(dir, "chrome.sock");
  const proc = spawn(process.execPath, [host], {
    env: { ...process.env, KERNAL_HOME: dir, KERNAL_CHROME_ACTION_TIMEOUT_MS: "100" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let held;
  try {
    await waitFor(proc, proc.stderr, "listening");
    proc.stdin.write(encodeNativeMessage(SHARE));
    await listedShares(sockPath, (msg) => msg.shares.length === 1);

    const actionFramePromise = readFrame(proc);
    const actionReplyPromise = sendLine(sockPath, '{"t":"action","tabId":4,"kind":"click","selector":"#go"}\n');
    const actionFrame = await actionFramePromise;
    assert.deepEqual(actionFrame, { t: "action", tabId: 4, kind: "click", selector: "#go", id: 1 });
    assert.deepEqual(JSON.parse(await actionReplyPromise), { t: "error", error: "action timed out" });

    const captureFramePromise = readFrame(proc);
    held = await holdLine(sockPath, '{"t":"capture","tabId":4}\n');
    const captureFrame = await captureFramePromise;
    assert.deepEqual(captureFrame, { t: "capture", tabId: 4, id: 2 });

    proc.stdin.write(encodeNativeMessage({ t: "acted", tabId: 4, id: actionFrame.id }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(held.text(), "");

    proc.stdin.write(encodeNativeMessage({
      t: "captured", tabId: 4, title: "Spec", url: "https://example.com/a", jpegBase64: JPEG_B64, id: captureFrame.id,
    }));
    const started = Date.now();
    while (!held.text().includes("\n")) {
      if (Date.now() - started > 4000) throw new Error(`socket timeout, got ${JSON.stringify(held.text())}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const reply = JSON.parse(held.text().trim().split("\n")[0]);
    assert.equal(reply.t, "captured");
    assert.equal(reply.tabId, 4);
    assert.equal(reply.title, "Spec");
  } finally {
    if (held) held.socket.destroy();
    await stop(proc);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an inspected reply strips an Authorization header value", () => {
  const secret = "super-secret-value";
  const applied = applyExtensionMessage([{ tabId: 4, title: "Spec", url: "https://example.com/a", sessionId: "floppy-1" }], {
    t: "inspected",
    tabId: 4,
    id: 3,
    messages: [`log: Authorization: Bearer ${secret}`],
    element: "button#go",
    headers: { Authorization: secret },
  });
  const encoded = JSON.stringify(applied.inspect);
  assert.equal(encoded.includes(secret), false);
  assert.equal(applied.inspect.kind, "done");
  assert.equal(applied.inspect.element, "button#go");
  assert.match(redactHeaderText(`Cookie: ${secret}`), /\[redacted\]/);
  assert.equal(redactHeaderText(`Cookie: ${secret}`).includes(secret), false);
  assert.equal(redactHeaderText(JSON.stringify({ Authorization: `Bearer ${secret}` })).includes(secret), false);
});

test("an unknown tab is not forwarded for inspect, and a shared tab returns redacted lines", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kernal-chrome-host-"));
  const sockPath = join(dir, "chrome.sock");
  const proc = spawn(process.execPath, [host], {
    env: { ...process.env, KERNAL_HOME: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const secret = "super-secret-value";
  try {
    await waitFor(proc, proc.stderr, "listening");
    proc.stdin.write(encodeNativeMessage(SHARE));
    await listedShares(sockPath, (msg) => msg.shares.length === 1);
    assert.equal(JSON.parse(await sendLine(sockPath, '{"t":"inspect","tabId":9}\n')).error, "tab is not shared");

    const framePromise = readFrame(proc);
    const replyPromise = sendLine(sockPath, '{"t":"inspect","tabId":4}\n');
    const frame = await framePromise;
    assert.deepEqual(frame, { t: "inspect", tabId: 4, id: 1 });
    proc.stdin.write(encodeNativeMessage({
      t: "inspected",
      tabId: 4,
      id: frame.id,
      messages: [`log: Authorization: Bearer ${secret}`],
      element: "div#main",
    }));
    const reply = JSON.parse(await replyPromise);
    assert.equal(reply.t, "inspected");
    assert.equal(JSON.stringify(reply).includes(secret), false);
    assert.match(reply.messages[0], /\[redacted\]/);
    assert.equal(reply.element, "div#main");
  } finally {
    await stop(proc);
    rmSync(dir, { recursive: true, force: true });
  }
});
