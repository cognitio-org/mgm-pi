/**
 * Browser IDE phase 2 (#242): the activity meter, the proxy's IDE options, and IdeManager against a
 * fake code-server (fake-code-server.ts), a fake tunnel and a fake installer. No network.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClientFrameCounter, IdeActivityMeter, IDE_ACTIVE_BYTES, IDE_ACTIVE_FRAMES, IDE_WINDOW_MS } from "../src/ide-activity.js";
import { IdeManager, IDE_MACHINE_SETTINGS, type IdeManagerOptions } from "../src/ide-server.js";
import { upstreamHeaders } from "../src/preview-proxy.js";
import type { UpIdeStatus } from "../src/protocol.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeCodeServer = join(here, "fake-code-server.js");
const trash: string[] = [];
after(() => { for (const d of trash) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "outfitter-ide-srv-")); trash.push(d); return d; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw new Error("timed out waiting"); await sleep(25); }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A masked client WebSocket frame (RFC 6455 §5.2). */
function frame(payload: Buffer, opcode = 2): Buffer {
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]!));
  let head: Buffer;
  if (payload.length < 126) head = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  else if (payload.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(payload.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(payload.length), 2); }
  return Buffer.concat([head, mask, masked]);
}

describe("ClientFrameCounter and IdeActivityMeter (#242)", () => {
  test("counts data frames across chunk boundaries and every length encoding; not pings", () => {
    const c = new ClientFrameCounter();
    const stream = Buffer.concat([frame(Buffer.alloc(10)), frame(Buffer.alloc(300)), frame(Buffer.alloc(70_000)), frame(Buffer.alloc(4), 9), frame(Buffer.alloc(3), 1)]);
    let frames = 0;
    for (let i = 0; i < stream.length; i += 7) frames += c.push(stream.subarray(i, i + 7)).frames;
    assert.equal(frames, 4, "binary x3 + text; the ping doesn't count");
  });

  test("a minute counts once, at the first threshold crossed; idle traffic never does", () => {
    let now = 0;
    let fired = 0;
    const m = new IdeActivityMeter({ onActive: () => fired++, now: () => now });
    for (let i = 0; i < 39; i++) m.record(1, 18); // an idle minute, as measured under gVisor
    assert.equal(fired, 0);
    now += IDE_WINDOW_MS;
    for (let i = 0; i < IDE_ACTIVE_FRAMES; i++) m.record(1, 10);
    assert.equal(fired, 1);
    for (let i = 0; i < 100; i++) m.record(1, 10);
    assert.equal(fired, 1, "once per window");
    now += IDE_WINDOW_MS;
    m.record(1, IDE_ACTIVE_BYTES);
    assert.equal(fired, 2, "bytes alone count too");
  });

  test("the proxy keeps Origin only when asked", () => {
    const h = { host: "abc.kernal.run", origin: "https://abc.kernal.run", upgrade: "websocket", connection: "Upgrade" };
    assert.equal(upstreamHeaders(h, 9000, true).origin, "http://localhost:9000", "dev-server previews unchanged");
    assert.equal(upstreamHeaders(h, 9000, true, { keepOrigin: true }).origin, "https://abc.kernal.run");
    assert.equal(upstreamHeaders(h, 9000, true, { keepOrigin: true })["x-forwarded-host"], "abc.kernal.run");
  });
});

function harness(extra: Partial<IdeManagerOptions> = {}, fakeMode = "") {
  const frames: UpIdeStatus[] = [];
  const tunnels: { upstream: string; url: string; authtoken: string; stopped: boolean; onExit: (r: string) => void }[] = [];
  let activity = 0;
  const claimed: number[][] = [];
  const home = tmp();
  const configDir = join(tmp(), "cfg");
  const workspace = tmp();
  const mgr = new IdeManager({
    installer: { state: "ready", start: async () => ({ ok: true, seconds: 0 }) },
    internalDomain: "rtest.internal",
    authtoken: "tok",
    workspace,
    home,
    configDir,
    send: (f) => frames.push(f),
    onActivity: () => activity++,
    onPortsClaimed: (ports) => claimed.push(ports),
    env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "url.x.insteadOf", GIT_CONFIG_VALUE_0: "y" },
    startTimeoutMs: 5000,
    spawnCodeServer: (_bin, args, opts) =>
      spawn(process.execPath, [fakeCodeServer, ...args], {
        env: { ...opts.env, ...(fakeMode ? { FAKE_CS_MODE: fakeMode } : {}) },
        cwd: opts.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    startTunnel: async (o) => {
      const t = { ...o, stopped: false };
      tunnels.push(t);
      return { url: o.url, stop: async () => { t.stopped = true; } };
    },
    ...extra,
  });
  const fake = () => JSON.parse(readFileSync(join(home, ".local/share/code-server/fake.json"), "utf8"));
  return { mgr, frames, tunnels, home, configDir, workspace, fake, claimed, activity: () => activity };
}

describe("IdeManager (#242)", () => {
  test("ide.open starts code-server as specified and answers ready with the internal URL", async (t) => {
    const h = harness();
    t.after(() => h.mgr.stop());
    h.mgr.open("r1");
    await waitFor(() => h.frames.some((f) => f.state === "ready" || f.state === "error"));
    assert.deepEqual(h.frames.map((f) => [f.reqId, f.state]), [["r1", "starting"], ["r1", "ready"]]);
    assert.equal(h.frames.at(-1)!.internalUrl, "https://ide.rtest.internal");

    const { argv, env } = h.fake();
    for (const flag of ["--auth", "--disable-proxy", "--disable-workspace-trust", "--disable-telemetry", "--disable-update-check"]) {
      assert.ok(argv.includes(flag), `code-server gets ${flag}`);
    }
    assert.equal(argv[argv.indexOf("--auth") + 1], "none");
    assert.match(argv[argv.indexOf("--bind-addr") + 1], /^127\.0\.0\.1:\d+$/, "loopback only");
    assert.equal(argv[argv.indexOf("--config") + 1], join(h.configDir, "config.yaml"));
    assert.equal(readFileSync(join(h.configDir, "config.yaml"), "utf8"), "", "an empty config: flags decide");
    assert.equal(argv.at(-1), h.workspace);
    assert.equal(env.SHELL, "/bin/bash", "terminals need a shell; agent's login shell is nologin");
    assert.equal(env.GIT_CONFIG_KEY_0, "url.x.insteadOf", "the run's git proxy");
    for (const secret of ["LITELLM_AGENT_KEY", "OUTFITTER_PREVIEW_TOKEN", "RUN_TOKEN", "OUTFITTER_BROWSER_TOKEN"]) {
      assert.equal(env[secret], undefined, `${secret} stays out`);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(h.home, ".local/share/code-server/Machine/settings.json"), "utf8")), IDE_MACHINE_SETTINGS);

    assert.equal(h.tunnels.length, 1);
    assert.equal(h.tunnels[0]!.url, "https://ide.rtest.internal");
    assert.equal(h.tunnels[0]!.authtoken, "tok");
    assert.equal(h.mgr.ports().length, 2, "code-server's and the proxy's ports, for reservedPorts");
    assert.deepEqual(h.claimed, [h.mgr.ports()], "the run is told which ports the IDE took");

    h.mgr.open("r2");
    assert.deepEqual(h.frames.at(-1), { t: "ide.status", reqId: "r2", state: "ready", internalUrl: "https://ide.rtest.internal" }, "a second click reuses it at once");
  });

  test("opens made while starting all get the answer", async (t) => {
    const h = harness();
    t.after(() => h.mgr.stop());
    h.mgr.open("a");
    h.mgr.open("b");
    await waitFor(() => h.frames.filter((f) => f.state === "ready").length === 2);
    assert.equal(h.tunnels.length, 1, "one code-server");
  });

  test("the proxy passes Origin through and real use counts as activity", async (t) => {
    const h = harness();
    t.after(() => h.mgr.stop());
    h.mgr.open("r1");
    await waitFor(() => h.frames.some((f) => f.state === "ready"));
    const proxyPort = Number(new URL(h.tunnels[0]!.upstream).port);
    const sock = connect(proxyPort, "127.0.0.1");
    await new Promise((r) => sock.once("connect", r));
    sock.write("GET /stable?x=1 HTTP/1.1\r\nHost: abc.kernal.run\r\nOrigin: https://abc.kernal.run\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
    await new Promise((r) => sock.once("data", r));
    await waitFor(() => h.fake().origins.length === 1);
    assert.deepEqual(h.fake().origins, ["https://abc.kernal.run"], "code-server sees the browser's Origin");
    for (let i = 0; i < 30; i++) sock.write(frame(Buffer.alloc(16)));
    await sleep(100);
    assert.equal(h.activity(), 0, "keepalive-like traffic isn't use");
    for (let i = 0; i < 40; i++) sock.write(frame(Buffer.alloc(16)));
    await waitFor(() => h.activity() === 1);
    sock.destroy();
  });

  test("a failed install answers error with the reason", async () => {
    const h = harness({ installer: { state: "failed", start: async () => ({ ok: false, error: "checksum mismatch", seconds: 1 }) } });
    h.mgr.open("r1");
    await waitFor(() => h.frames.some((f) => f.state === "error"));
    assert.deepEqual(h.frames.map((f) => f.state), ["installing", "error"]);
    assert.match(h.frames.at(-1)!.detail ?? "", /checksum mismatch/);
    await h.mgr.stop();
  });

  test("code-server that never listens times out as an error, and its process group goes", async () => {
    const h = harness({ startTimeoutMs: 700 }, "never-listen");
    h.mgr.open("r1");
    await waitFor(() => h.frames.some((f) => f.state === "error"));
    assert.match(h.frames.at(-1)!.detail ?? "", /didn't start listening/);
    const { grandchild } = h.fake();
    await waitFor(() => !alive(grandchild), 5000);
    assert.equal(h.tunnels.length, 0, "no tunnel for a server that never came up");
    await h.mgr.stop();
  });

  test("code-server dying after it's ready sends an unprompted stopped, and the next open starts it again", async (t) => {
    const h = harness({}, "die-after=600");
    t.after(() => h.mgr.stop());
    h.mgr.open("r1");
    await waitFor(() => h.frames.some((f) => f.state === "stopped"));
    const stopped = h.frames.find((f) => f.state === "stopped")!;
    assert.equal(stopped.reqId, undefined);
    assert.match(stopped.detail ?? "", /code-server exited/);
    assert.equal(h.tunnels[0]!.stopped, true, "its tunnel goes with it");
    const firstGrandchild = h.fake().grandchild;
    await waitFor(() => !alive(firstGrandchild), 5000); // the whole group, though its top process had already exited
    h.mgr.open("r2");
    await waitFor(() => h.frames.some((f) => f.reqId === "r2" && (f.state === "ready" || f.state === "error")));
    assert.equal(h.frames.filter((f) => f.reqId === "r2").at(-1)!.state, "ready", "it starts again");
  });

  test("stop() during a slow start returns promptly instead of waiting out the startup timeout", async () => {
    const h = harness({ startTimeoutMs: 30_000 }, "never-listen");
    h.mgr.open("r1");
    await waitFor(() => h.frames.some((f) => f.state === "starting"));
    await sleep(300);
    const t0 = Date.now();
    await h.mgr.stop();
    assert.ok(Date.now() - t0 < 5000, `stop took ${Date.now() - t0} ms`);
    await waitFor(() => h.frames.some((f) => f.state === "error"));
    const { grandchild } = h.fake();
    await waitFor(() => !alive(grandchild), 5000);
  });

  test("stop() kills the whole process group, the tunnel and the proxy", async () => {
    const h = harness();
    h.mgr.open("r1");
    await waitFor(() => h.frames.some((f) => f.state === "ready"));
    const { grandchild } = h.fake();
    assert.ok(alive(grandchild));
    const proxyPort = Number(new URL(h.tunnels[0]!.upstream).port);
    await h.mgr.stop();
    await waitFor(() => !alive(grandchild), 5000);
    assert.equal(h.tunnels[0]!.stopped, true);
    assert.equal(h.mgr.ports().length, 0);
    const refused = await new Promise<boolean>((r) => { const s = connect(proxyPort, "127.0.0.1"); s.once("error", () => r(true)); s.once("connect", () => { s.destroy(); r(false); }); });
    assert.ok(refused, "the proxy is closed");
    h.mgr.open("late");
    assert.deepEqual(h.frames.at(-1), { t: "ide.status", reqId: "late", state: "error", detail: "the run is stopping" });
  });

  test("the config dir and file are created for root to own", async (t) => {
    const h = harness();
    t.after(() => h.mgr.stop());
    h.mgr.open("r1");
    await waitFor(() => h.frames.some((f) => f.state === "ready"));
    assert.ok(existsSync(join(h.configDir, "config.yaml")));
    assert.equal(statSync(join(h.configDir, "config.yaml")).mode & 0o022, 0, "not group- or world-writable");
  });
});

describe("IdeManager peer check (#242)", () => {
  test("a refused peer gets 403 on HTTP, its WebSocket is dropped, and nothing counts as activity", async (t) => {
    const h = harness({ peerAllowed: async () => false });
    t.after(() => h.mgr.stop());
    h.mgr.open("r1");
    await waitFor(() => h.frames.some((f) => f.state === "ready"));
    const proxyPort = Number(new URL(h.tunnels[0]!.upstream).port);
    const http = await new Promise<string>((resolve) => {
      const s = connect(proxyPort, "127.0.0.1", () => s.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
      s.once("data", (d) => { resolve(d.toString().split("\r\n")[0]!); s.destroy(); });
    });
    assert.match(http, /403/);
    const closed = await new Promise<boolean>((resolve) => {
      const s = connect(proxyPort, "127.0.0.1", () => {
        s.write("GET /ws HTTP/1.1\r\nHost: x\r\nOrigin: https://x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n");
        for (let i = 0; i < 100; i++) s.write(frame(Buffer.alloc(16)));
      });
      s.on("error", () => {});
      s.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 3000);
    });
    assert.ok(closed, "the upgrade is dropped");
    await sleep(100);
    assert.equal(h.activity(), 0);
    assert.deepEqual(h.fake().origins, [], "nothing reached code-server");
  });
});
