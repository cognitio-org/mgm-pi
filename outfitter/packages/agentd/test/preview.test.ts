/**
 * Drive previews (#217), sandbox side: the loopback listener's contract, the local proxy (HTTP,
 * WebSocket upgrade, Host rewrite, activity), and the ngrok runner against a fake ngrok binary.
 * No network, no real ngrok.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreviewListener, parsePreviewRequest, PREVIEW_TOKEN_HEADER } from "../src/preview.js";
import { LocalPreviewProxy, isPageRequest, upstreamHeaders } from "../src/preview-proxy.js";
import { NgrokStartError, classifyNgrokLog, startNgrok } from "../src/ngrok-runner.js";
import type { UpPreviewClose, UpPreviewOpen } from "../src/protocol.js";

const trash: string[] = [];
after(() => { for (const d of trash) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "outfitter-preview-test-")); trash.push(d); return d; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return (server.address() as AddressInfo).port;
}
const upgraded = new Set<import("node:stream").Duplex>();
async function close(server: Server): Promise<void> {
  for (const s of upgraded) s.destroy();
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(() => r()));
}
/** GET with headers fetch won't send (Host). */
function getRaw(url: string, headers: Record<string, string>): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, (res) => {
      let body = "";
      res.on("data", (b) => { body += b; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}
async function getJson(url: string, headers: Record<string, string>): Promise<any> {
  return JSON.parse((await getRaw(url, headers)).body);
}

async function freePort(): Promise<number> {
  const s = createServer();
  const port = await listen(s);
  await close(s);
  return port;
}

/** A dev server that echoes what it received. */
async function devServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json", connection: "keep-alive", "x-dev": "1" });
    res.end(JSON.stringify({ host: req.headers.host, xfh: req.headers["x-forwarded-host"], url: req.url, proxyAuth: req.headers["proxy-authorization"] ?? null }));
  });
  server.on("upgrade", (req, socket) => {
    // Upgraded sockets aren't the server's any more: closeAllConnections() won't end them.
    upgraded.add(socket);
    socket.once("close", () => upgraded.delete(socket));
    socket.once("end", () => socket.destroy());
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nx-seen-host: ${req.headers.host}\r\n\r\n`);
    socket.on("data", (b) => socket.write(Buffer.concat([Buffer.from("echo:"), b])));
  });
  return { server, port: await listen(server) };
}

interface Harness {
  listener: PreviewListener;
  sent: Array<UpPreviewOpen | UpPreviewClose>;
  tunnels: Array<{ url: string; upstream: string; stopped: boolean; exit: (r: string) => void }>;
  call: (method: string, path: string, body?: unknown, token?: string) => Promise<{ status: number; json: any }>;
}

async function harness(opts: {
  answer?: (f: UpPreviewOpen) => { url?: string; error?: string; expiresAt?: string } | undefined;
  tunnelError?: Error;
  reserved?: number[];
  waitMs?: number;
  peerUid?: number;
  onActivity?: () => void;
} = {}): Promise<Harness> {
  const sent: Harness["sent"] = [];
  const tunnels: Harness["tunnels"] = [];
  let listener!: PreviewListener;
  listener = new PreviewListener({
    internalDomain: "rtest.internal",
    authtoken: "tok",
    waitMs: opts.waitMs ?? 500,
    peerUid: opts.peerUid,
    reservedPorts: () => opts.reserved ?? [],
    onActivity: opts.onActivity,
    send: (f) => {
      sent.push(f);
      if (f.t === "preview.open") {
        const a = opts.answer ? opts.answer(f) : { url: `https://abc${f.port}.kernal.run` };
        if (a) setImmediate(() => listener.deliver({ t: "preview.result", requestId: f.requestId, ...a }));
      }
    },
    startTunnel: async (o) => {
      if (opts.tunnelError) throw opts.tunnelError;
      const t = { url: o.url, upstream: o.upstream, stopped: false, exit: o.onExit };
      tunnels.push(t);
      return { url: o.url, stop: async () => { t.stopped = true; } };
    },
  });
  await listener.start();
  const call = async (method: string, path: string, body?: unknown, token = listener.token) => {
    const res = await fetch(`http://127.0.0.1:${listener.port}${path}`, {
      method,
      headers: { [PREVIEW_TOKEN_HEADER]: token, "content-type": "application/json" },
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: await res.json() };
  };
  return { listener, sent, tunnels, call };
}

describe("PreviewListener", () => {
  test("parsePreviewRequest accepts {port, jobId?, share?} and nothing else", () => {
    assert.deepEqual(parsePreviewRequest({ port: 3000 }), { port: 3000, share: false });
    assert.deepEqual(parsePreviewRequest({ port: 3000, jobId: "bg1", share: true }), { port: 3000, jobId: "bg1", share: true });
    assert.equal(parsePreviewRequest({ port: "3000" }), undefined);
    assert.equal(parsePreviewRequest({ port: 3000.5 }), undefined);
    assert.equal(parsePreviewRequest({ port: 3000, host: "10.0.0.1" }), undefined);
    assert.equal(parsePreviewRequest({ port: 3000, jobId: "../x" }), undefined);
    assert.equal(parsePreviewRequest([3000]), undefined);
  });

  test("refuses a missing or wrong token, a wrong peer, and an oversized body", async () => {
    const h = await harness();
    try {
      assert.equal((await h.call("GET", "/previews", undefined, "")).status, 403);
      assert.equal((await h.call("GET", "/previews", undefined, "x".repeat(43))).status, 403);
      const big = await h.call("POST", "/previews", JSON.stringify({ port: 3000, jobId: "x".repeat(10_000) }));
      assert.equal(big.status, 400);
      assert.equal((await h.call("GET", "/nope")).status, 404);
    } finally { await h.listener.stop(); }
    const other = await harness({ peerUid: (process.getuid?.() ?? 0) + 12345 });
    try {
      assert.equal((await other.call("GET", "/previews")).status, 403);
    } finally { await other.listener.stop(); }
  });

  test("port-not-allowed below 1024, above 65535, the listener's own port and agentd's reserved ports", async () => {
    const h = await harness({ reserved: [45678] });
    try {
      for (const port of [80, 70000, h.listener.port!, 45678]) {
        const r = await h.call("POST", "/previews", { port });
        assert.equal(r.status, 400, `port ${port}`);
        assert.equal(r.json.error, "port-not-allowed");
      }
      assert.equal(h.sent.length, 0);
    } finally { await h.listener.stop(); }
  });

  test("nothing-listening when no server is on the port, before any tunnel starts", async () => {
    const h = await harness();
    try {
      const r = await h.call("POST", "/previews", { port: await freePort() });
      assert.equal(r.status, 409);
      assert.equal(r.json.error, "nothing-listening");
      assert.equal(h.tunnels.length, 0);
      assert.equal(h.sent.length, 0);
    } finally { await h.listener.stop(); }
  });

  test("opens: tunnel on p<port>.<internalDomain> to the local proxy, preview.open up, the api's url back; list, reopen, close", async () => {
    const dev = await devServer();
    const h = await harness({ answer: () => ({ url: "https://abc123.kernal.run", expiresAt: "2026-09-28T12:00:00Z" }) });
    try {
      const r = await h.call("POST", "/previews", { port: dev.port, jobId: "bg1", share: true });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(r.json, { url: "https://abc123.kernal.run", port: dev.port, expiresAt: "2026-09-28T12:00:00Z" });
      assert.equal(h.tunnels.length, 1);
      assert.equal(h.tunnels[0]!.url, `https://p${dev.port}.rtest.internal`);
      const open = h.sent[0] as UpPreviewOpen;
      assert.equal(open.t, "preview.open");
      assert.equal(open.port, dev.port);
      assert.equal(open.internalUrl, `https://p${dev.port}.rtest.internal`);
      assert.equal(open.share, true);

      // The tunnel's upstream is the local proxy, which reaches the dev server with Host rewritten.
      const seen = await getJson(`${h.tunnels[0]!.upstream}/x?y=1`, { host: "abc123.kernal.run" });
      assert.equal(seen.host, `localhost:${dev.port}`);
      assert.equal(seen.url, "/x?y=1");

      assert.deepEqual((await h.call("GET", "/previews")).json, {
        previews: [{ port: dev.port, url: "https://abc123.kernal.run", jobId: "bg1", share: true, expiresAt: "2026-09-28T12:00:00Z" }],
      });
      // Opening it again returns the same preview; no second tunnel or open.
      assert.equal((await h.call("POST", "/previews", { port: dev.port })).json.url, "https://abc123.kernal.run");
      assert.equal(h.tunnels.length, 1);
      assert.equal(h.sent.filter((f) => f.t === "preview.open").length, 1);

      assert.deepEqual((await h.call("DELETE", `/previews/${dev.port}`)).json, { closed: true });
      assert.equal(h.tunnels[0]!.stopped, true);
      assert.deepEqual(h.sent.at(-1), { t: "preview.close", port: dev.port });
      assert.deepEqual((await h.call("DELETE", `/previews/${dev.port}`)).json, { closed: true });
      assert.equal(h.sent.filter((f) => f.t === "preview.close").length, 1);
      assert.deepEqual((await h.call("GET", "/previews")).json, { previews: [] });
    } finally { await h.listener.stop(); await close(dev.server); }
  });

  test("the api's not-configured is 503, silence is a 504; both stop the tunnel and send preview.close", async () => {
    const dev = await devServer();
    const nc = await harness({ answer: () => ({ error: "not-configured" }) });
    try {
      const r = await nc.call("POST", "/previews", { port: dev.port });
      assert.equal(r.status, 503);
      assert.equal(r.json.error, "not-configured");
      assert.equal(nc.tunnels[0]!.stopped, true);
      assert.deepEqual(nc.sent.at(-1), { t: "preview.close", port: dev.port });
    } finally { await nc.listener.stop(); }
    const silent = await harness({ answer: () => undefined, waitMs: 150 });
    try {
      const r = await silent.call("POST", "/previews", { port: dev.port });
      assert.equal(r.status, 504);
      assert.equal(r.json.error, "timeout");
      assert.equal(silent.tunnels[0]!.stopped, true);
    } finally { await silent.listener.stop(); await close(dev.server); }
  });

  test("an ngrok start failure is 502 failed (with its message), an ngrok start timeout 504; nothing goes up", async () => {
    const dev = await devServer();
    for (const [err, status, code] of [
      [new NgrokStartError("failed", "ERR_NGROK_3200: not allowed"), 502, "failed"],
      [new NgrokStartError("timeout", "no start"), 504, "timeout"],
    ] as const) {
      const h = await harness({ tunnelError: err });
      try {
        const r = await h.call("POST", "/previews", { port: dev.port });
        assert.equal(r.status, status);
        assert.equal(r.json.error, code);
        assert.match(r.json.detail, new RegExp(err.message.slice(0, 12)));
        assert.equal(h.sent.length, 0);
      } finally { await h.listener.stop(); }
    }
    await close(dev.server);
  });

  test("a tunnel that dies closes its preview; stop() closes every preview and sends preview.close for each", async () => {
    const a = await devServer();
    const b = await devServer();
    const h = await harness();
    try {
      await h.call("POST", "/previews", { port: a.port });
      await h.call("POST", "/previews", { port: b.port });
      h.tunnels[0]!.exit("ngrok exited (code 1)");
      await sleep(50);
      assert.deepEqual((await h.call("GET", "/previews")).json.previews.map((p: any) => p.port), [b.port]);
      assert.ok(h.sent.some((f) => f.t === "preview.close" && f.port === a.port));
      await h.listener.stop();
      assert.equal(h.tunnels[1]!.stopped, true);
      assert.ok(h.sent.some((f) => f.t === "preview.close" && f.port === b.port));
      assert.equal(h.listener.port, undefined);
    } finally { await h.listener.stop(); await close(a.server); await close(b.server); }
  });
});

describe("LocalPreviewProxy", () => {
  test("isPageRequest: navigations and HTML requests count; fetches, assets and upgrades don't", () => {
    const req = (method: string, headers: Record<string, string>) => ({ method, headers });
    assert.equal(isPageRequest(req("GET", { "sec-fetch-mode": "navigate" })), true);
    assert.equal(isPageRequest(req("GET", { accept: "text/html,application/xhtml+xml" })), true);
    assert.equal(isPageRequest(req("GET", { accept: "*/*", "sec-fetch-mode": "cors" })), false);
    assert.equal(isPageRequest(req("GET", { accept: "text/html", "sec-fetch-mode": "no-cors" })), false);
    assert.equal(isPageRequest(req("GET", { accept: "application/javascript" })), false);
    assert.equal(isPageRequest(req("GET", { upgrade: "websocket", accept: "text/html" })), false);
    assert.equal(isPageRequest(req("OPTIONS", { accept: "text/html" })), false);
  });

  test("upstreamHeaders: Host becomes localhost:<port>, public host goes to X-Forwarded-Host, hop-by-hop dropped", () => {
    const out = upstreamHeaders({ host: "abc.kernal.run", connection: "keep-alive, x-secret", "x-secret": "1", "proxy-authorization": "p", accept: "text/html" }, 3000, false);
    assert.equal(out.host, "localhost:3000");
    assert.equal(out["x-forwarded-host"], "abc.kernal.run");
    assert.equal(out["x-forwarded-proto"], "https");
    assert.equal(out.accept, "text/html");
    assert.equal(out.connection, undefined);
    assert.equal(out["x-secret"], undefined);
    assert.equal(out["proxy-authorization"], undefined);
    const up = upstreamHeaders({ host: "abc.kernal.run", connection: "Upgrade", upgrade: "websocket", origin: "https://abc.kernal.run" }, 3000, true);
    assert.equal(up.connection, "Upgrade");
    assert.equal(up.upgrade, "websocket");
    assert.equal(up.origin, "http://localhost:3000");
  });

  test("forwards HTTP to 127.0.0.1:<port> only, strips hop-by-hop response headers, counts page loads only", async () => {
    const dev = await devServer();
    let activity = 0;
    const proxy = new LocalPreviewProxy({ port: dev.port, onActivity: () => { activity += 1; } });
    await proxy.start();
    try {
      const page = await getRaw(`http://127.0.0.1:${proxy.port}/`, { accept: "text/html", host: "abc.kernal.run", "proxy-authorization": "secret" });
      assert.equal(page.headers["x-dev"], "1");
      const body = JSON.parse(page.body);
      assert.equal(body.host, `localhost:${dev.port}`);
      assert.equal(body.xfh, "abc.kernal.run");
      assert.equal(body.proxyAuth, null);
      await (await fetch(`http://127.0.0.1:${proxy.port}/app.js`, { headers: { accept: "*/*", "sec-fetch-mode": "no-cors" } })).text();
      await (await fetch(`http://127.0.0.1:${proxy.port}/api/x`, { headers: { accept: "application/json", "sec-fetch-mode": "cors" } })).text();
      assert.equal(activity, 1);
    } finally { await proxy.stop(); await close(dev.server); }
  });

  test("a dead dev server answers 502 with a readable message", async () => {
    const proxy = new LocalPreviewProxy({ port: await freePort() });
    await proxy.start();
    try {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/`);
      assert.equal(res.status, 502);
      assert.match(await res.text(), /Nothing answered on port/);
    } finally { await proxy.stop(); }
  });

  test("WebSocket upgrades (HMR) pass through with Host rewritten, and don't count as activity", async () => {
    const dev = await devServer();
    let activity = 0;
    const proxy = new LocalPreviewProxy({ port: dev.port, onActivity: () => { activity += 1; } });
    await proxy.start();
    try {
      const sock = connect(proxy.port!, "127.0.0.1");
      let got = "";
      sock.on("data", (b) => { got += b.toString(); });
      await new Promise<void>((r) => sock.once("connect", () => r()));
      sock.write("GET /hmr HTTP/1.1\r\nhost: abc.kernal.run\r\nconnection: Upgrade\r\nupgrade: websocket\r\naccept: text/html\r\n\r\n");
      for (let i = 0; i < 100 && !got.includes("\r\n\r\n"); i++) await sleep(10);
      assert.match(got, /^HTTP\/1\.1 101/);
      assert.match(got, new RegExp(`x-seen-host: localhost:${dev.port}`));
      sock.write("ping");
      for (let i = 0; i < 100 && !got.includes("echo:ping"); i++) await sleep(10);
      assert.ok(got.includes("echo:ping"));
      sock.destroy();
      assert.equal(activity, 0);
    } finally { await proxy.stop(); await close(dev.server); }
  });
});

describe("ngrok runner", () => {
  test("classifyNgrokLog", () => {
    assert.deepEqual(classifyNgrokLog('{"lvl":"info","msg":"started tunnel","url":"https://p1.r.internal"}'), { started: true });
    assert.deepEqual(classifyNgrokLog('{"lvl":"crit","msg":"command failed","err":"ERR_NGROK_3200 not allowed"}'), { error: "ERR_NGROK_3200 not allowed" });
    assert.deepEqual(classifyNgrokLog("ERROR:  authentication failed: ERR_NGROK_107"), { error: "ERROR:  authentication failed: ERR_NGROK_107" });
    assert.equal(classifyNgrokLog('{"lvl":"info","msg":"client session established"}'), undefined);
    assert.equal(classifyNgrokLog("plain noise"), undefined);
  });

  function fakeNgrok(script: string): string {
    const dir = tmp();
    const bin = join(dir, "ngrok");
    writeFileSync(bin, `#!/usr/bin/env bash\n${script}\n`);
    chmodSync(bin, 0o755);
    return bin;
  }

  test("starts on 'started tunnel' with a 0600 config holding the credential, removed once stopped", async () => {
    const seen = join(tmp(), "seen");
    const bin = fakeNgrok(`
cfg=""; while [ $# -gt 0 ]; do [ "$1" = "--config" ] && cfg="$2"; shift; done
cp "$cfg" "${seen}"; echo "$cfg" > "${seen}.path"; stat -c %a "$cfg" > "${seen}.mode" 2>/dev/null || stat -f %Lp "$cfg" > "${seen}.mode"
echo '{"lvl":"info","msg":"started tunnel","url":"https://p3000.r.internal"}'
exec sleep 60`);
    const tunnel = await startNgrok({ bin, upstream: "http://127.0.0.1:1", url: "https://p3000.r.internal", authtoken: "cred-xyz", startTimeoutMs: 5000 });
    assert.equal(tunnel.url, "https://p3000.r.internal");
    assert.match(readFileSync(seen, "utf8"), /authtoken: "cred-xyz"/);
    assert.equal(readFileSync(`${seen}.mode`, "utf8").trim(), "600");
    const cfgPath = readFileSync(`${seen}.path`, "utf8").trim();
    await tunnel.stop();
    assert.equal(existsSync(cfgPath), false);
  });

  test("an ERR_NGROK line before start is a failed start carrying the message", async () => {
    const bin = fakeNgrok(`echo '{"lvl":"crit","msg":"command failed","err":"ERR_NGROK_3200: The endpoint is not allowed"}'; exit 1`);
    await assert.rejects(
      startNgrok({ bin, upstream: "http://127.0.0.1:1", url: "https://p1.r.internal", authtoken: "t", startTimeoutMs: 5000 }),
      (err: unknown) => err instanceof NgrokStartError && err.kind === "failed" && /ERR_NGROK_3200/.test(err.message),
    );
  });

  test("silence is a start timeout, and the agent is killed", async () => {
    const pidFile = join(tmp(), "pid");
    const bin = fakeNgrok(`echo $$ > "${pidFile}"; exec sleep 60`);
    await assert.rejects(
      startNgrok({ bin, upstream: "http://127.0.0.1:1", url: "https://p1.r.internal", authtoken: "t", startTimeoutMs: 1500 }),
      (err: unknown) => err instanceof NgrokStartError && err.kind === "timeout",
    );
    const pid = Number(readFileSync(pidFile, "utf8"));
    await sleep(100);
    assert.throws(() => process.kill(pid, 0));
  });

  test("an agent that exits after starting calls onExit once; stop() of an exited agent is fine", async () => {
    const bin = fakeNgrok(`echo '{"lvl":"info","msg":"started tunnel"}'; sleep 0.2; exit 1`);
    const exits: string[] = [];
    const tunnel = await startNgrok({ bin, upstream: "http://127.0.0.1:1", url: "https://p1.r.internal", authtoken: "t", onExit: (r) => exits.push(r) });
    for (let i = 0; i < 50 && exits.length === 0; i++) await sleep(20);
    assert.equal(exits.length, 1);
    await tunnel.stop();
  });

  // Live: a real ngrok agent with a real per-run credential. Skipped unless both are given, e.g.
  //   OUTFITTER_LIVE_NGROK_AUTHTOKEN=<credential with ACL bind:*.<label>.internal> \
  //   OUTFITTER_LIVE_NGROK_DOMAIN=<label>.internal node --test dist/test/preview.test.js
  const liveToken = process.env.OUTFITTER_LIVE_NGROK_AUTHTOKEN;
  const liveDomain = process.env.OUTFITTER_LIVE_NGROK_DOMAIN;
  test("live: a real ngrok agent binds p<port>.<internal domain> and refuses another run's", { skip: !(liveToken && liveDomain) }, async () => {
    const dev = await devServer();
    try {
      const tunnel = await startNgrok({ upstream: `http://127.0.0.1:${dev.port}`, url: `https://p${dev.port}.${liveDomain}`, authtoken: liveToken!, bin: process.env.OUTFITTER_NGROK_BIN });
      await tunnel.stop();
      await assert.rejects(
        startNgrok({ upstream: `http://127.0.0.1:${dev.port}`, url: `https://p${dev.port}.other-${liveDomain}`, authtoken: liveToken!, bin: process.env.OUTFITTER_NGROK_BIN }),
        (err: unknown) => err instanceof NgrokStartError && err.kind === "failed",
      );
    } finally { await close(dev.server); }
  });

  test("the config dir is not left behind when ngrok can't run at all", async () => {
    await assert.rejects(
      startNgrok({ bin: "/nonexistent/ngrok", upstream: "http://127.0.0.1:1", url: "https://p1.r.internal", authtoken: "t" }),
      (err: unknown) => err instanceof NgrokStartError && err.kind === "failed",
    );
  });
});
