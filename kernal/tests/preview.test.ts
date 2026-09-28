/**
 * Previews (#217), the Kernal side: the `preview` tool on the desktop (localhost) and in a Drive
 * (agentd's loopback listener, faked here), and a preview's life tied to its job. No network
 * beyond 127.0.0.1.
 */
import { test, describe, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";

import {
  PREVIEW_TOKEN_HEADER, PreviewError, closeDrivePreview, desktopPreview, driveEndpoint, drivePreview, probePort, validPort,
} from "../.pi/extensions/kernal-background/preview.ts";
import extension, { endNotice } from "../.pi/extensions/kernal-background/index.ts";

const servers: Array<Server | TcpServer> = [];
after(() => { for (const s of servers) s.close(); });
const ENV_KEYS = ["OUTFITTER_PREVIEW_PORT", "OUTFITTER_PREVIEW_TOKEN", "OUTFITTER_RUN_ID", "OUTFITTER_SESSION_ID", "OUTFITTER_IDE"];
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });

function listen(server: Server | TcpServer): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as any).port)));
}
async function freePort(): Promise<number> {
  const s = createTcpServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stand-in for agentd's preview listener (the contract in drive-previews.md). */
async function fakeAgentd(opts: { token: string; reply?: (body: any) => { status: number; json: any } }) {
  const calls: Array<{ method: string; url: string; token?: string; body?: any }> = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method: req.method!, url: req.url!, token: req.headers[PREVIEW_TOKEN_HEADER] as string | undefined, body });
      if (req.headers[PREVIEW_TOKEN_HEADER] !== opts.token) { res.writeHead(403).end(JSON.stringify({ error: "forbidden" })); return; }
      if (req.method === "DELETE") { res.writeHead(200).end(JSON.stringify({ closed: true })); return; }
      const r = opts.reply?.(body) ?? { status: 200, json: { url: `https://abc${body.port}.kernal.run/`, port: body.port } };
      res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.json));
    });
  });
  const port = await listen(server);
  return { port, calls };
}

/** Enough of pi to load the extension and call its tools. */
function loadExtension() {
  const tools = new Map<string, any>();
  const messages: any[] = [];
  const handlers = new Map<string, Array<(e: any, c: any) => any>>();
  const pi: any = {
    on: (ev: string, h: any) => handlers.set(ev, [...(handlers.get(ev) ?? []), h]),
    registerTool: (t: any) => tools.set(t.name, t),
    registerCommand: () => {},
    sendMessage: (m: any) => messages.push(m),
  };
  extension(pi);
  const ctx = { cwd: process.cwd(), mode: "rpc", ui: {} };
  const call = async (name: string, params: any) => {
    const r = await tools.get(name).execute("id", params, undefined, undefined, ctx);
    return { text: r.content[0].text as string, isError: Boolean(r.isError) };
  };
  const shutdown = async () => { for (const h of handlers.get("session_shutdown") ?? []) await h({ reason: "quit" }, ctx); };
  return { tools, messages, call, shutdown };
}

describe("preview helpers", () => {
  test("validPort and driveEndpoint", () => {
    assert.equal(validPort(3000), true);
    assert.equal(validPort(0), false);
    assert.equal(validPort(70000), false);
    assert.equal(validPort(3000.5), false);
    assert.equal(driveEndpoint({}), undefined);
    assert.equal(driveEndpoint({ OUTFITTER_PREVIEW_PORT: "4567" }), undefined, "no token, no endpoint");
    assert.deepEqual(driveEndpoint({ OUTFITTER_PREVIEW_PORT: "4567", OUTFITTER_PREVIEW_TOKEN: "t" }), { port: 4567, token: "t" });
  });

  test("probePort and desktopPreview", async () => {
    const port = await listen(createTcpServer());
    assert.equal(await probePort(port), true);
    assert.deepEqual(await desktopPreview(port), { url: `http://localhost:${port}`, port });
    const dead = await freePort();
    assert.equal(await probePort(dead), false);
    await assert.rejects(desktopPreview(dead), (e: any) => e instanceof PreviewError && e.code === "nothing-listening");
  });

  test("drivePreview sends the token and the request, and returns agentd's URL", async () => {
    const agentd = await fakeAgentd({ token: "secret" });
    const r = await drivePreview({ port: agentd.port, token: "secret" }, 3000, { jobId: "bg1", share: true });
    assert.equal(r.url, "https://abc3000.kernal.run/");
    assert.deepEqual(agentd.calls[0], { method: "POST", url: "/previews", token: "secret", body: { port: 3000, jobId: "bg1", share: true } });
    await closeDrivePreview({ port: agentd.port, token: "secret" }, 3000);
    assert.equal(agentd.calls[1].method, "DELETE");
    assert.equal(agentd.calls[1].url, "/previews/3000");
  });

  test("agentd's errors come back as PreviewError with its code", async () => {
    const agentd = await fakeAgentd({ token: "t", reply: () => ({ status: 409, json: { error: "nothing-listening", detail: "port 3000 refused" } }) });
    await assert.rejects(drivePreview({ port: agentd.port, token: "t" }, 3000), (e: any) => e.code === "nothing-listening" && /refused/.test(e.message));
    await assert.rejects(drivePreview({ port: agentd.port, token: "wrong" }, 3000), (e: any) => e.code === "forbidden");
    await assert.rejects(drivePreview({ port: await freePort(), token: "t" }, 3000), (e: any) => e.code === "unavailable");
  });
});

describe("the preview tool", () => {
  test("desktop: localhost for a job's port, and the preview closes when the job ends", async () => {
    const x = loadExtension();
    const port = await freePort();
    const run = await x.call("background", { action: "run", kind: "server", port, command: `exec node -e "require('http').createServer((q,s)=>s.end('hi')).listen(${port}, '127.0.0.1')"` });
    assert.equal(run.isError, false, run.text);
    assert.match(run.text, /call preview with job_id bg1/);
    for (let i = 0; i < 60 && !(await probePort(port)); i++) await sleep(50);
    const p = await x.call("preview", { job_id: "bg1" });
    assert.equal(p.isError, false, p.text);
    assert.match(p.text, new RegExp(`http://localhost:${port}`));
    assert.match((await x.call("preview", { job_id: "bg1" })).text, /Already open/);
    const k = await x.call("background", { action: "kill", id: "bg1" });
    assert.match(k.text, new RegExp(`Its preview \\(http://localhost:${port}\\) was closed`));
    assert.match((await x.call("preview", { port, close: true })).text, /No preview is open/);
    await x.shutdown();
  });

  test("desktop: nothing listening, share refused, bad input", async () => {
    const x = loadExtension();
    const dead = await freePort();
    const r = await x.call("preview", { port: dead });
    assert.equal(r.isError, true);
    assert.match(r.text, /nothing is listening on port/);
    assert.match((await x.call("preview", {})).text, /Give job_id/);
    assert.match((await x.call("preview", { job_id: "bg9" })).text, /No background job bg9/);
    await x.shutdown();
  });

  test("Drive: goes through agentd, a job's end closes the tunnel and says so", async () => {
    const agentd = await fakeAgentd({ token: "tok" });
    process.env.OUTFITTER_PREVIEW_PORT = String(agentd.port);
    process.env.OUTFITTER_PREVIEW_TOKEN = "tok";
    const x = loadExtension();
    await x.call("background", { action: "run", kind: "server", port: 3000, command: "sleep 0.5" });
    const p = await x.call("preview", { job_id: "bg1" });
    assert.equal(p.isError, false, p.text);
    assert.match(p.text, /https:\/\/abc3000\.kernal\.run\//);
    assert.match(p.text, /Only people with access to this session/);
    assert.deepEqual(agentd.calls[0].body, { port: 3000, jobId: "bg1" });
    // the job exits on its own: the notice carries the closed preview, and agentd got the DELETE
    for (let i = 0; i < 100 && x.messages.length === 0; i++) await sleep(50);
    assert.equal(x.messages.length, 1);
    assert.match(x.messages[0].content, /Its preview \(https:\/\/abc3000\.kernal\.run\/\) was closed/);
    assert.ok(agentd.calls.some((c) => c.method === "DELETE" && c.url === "/previews/3000"));
    await x.shutdown();
  });

  test("Drive: the api's refusals come back as instructions", async () => {
    const agentd = await fakeAgentd({ token: "tok", reply: () => ({ status: 403, json: { error: "share-not-allowed", detail: "share-not-allowed" } }) });
    process.env.OUTFITTER_PREVIEW_PORT = String(agentd.port);
    process.env.OUTFITTER_PREVIEW_TOKEN = "tok";
    const x = loadExtension();
    const r = await x.call("preview", { port: 3000 });
    assert.equal(r.isError, true);
    assert.match(r.text, /made by the person, from the session page/);
    await x.shutdown();
  });

  test("Drive without previews enabled says so instead of handing out localhost", async () => {
    process.env.OUTFITTER_SESSION_ID = "s1";
    const x = loadExtension();
    const port = await listen(createTcpServer());
    const r = await x.call("preview", { port });
    assert.equal(r.isError, true);
    assert.match(r.text, /aren't enabled for this Drive/);
    await x.shutdown();
  });
});

test("endNotice mentions a closed preview", () => {
  const job: any = { id: "bg1", name: "vite", kind: "server", status: "killed", startedAt: 0, endedAt: 1000, logPath: "/l", pid: 1, deadlineAt: 0 };
  assert.match(endNotice(job, "", "https://x.kernal.run/"), /Its preview \(https:\/\/x\.kernal\.run\/\) was closed\./);
});

describe("vscode tool (#273)", () => {
  test("only offered in a Drive with the IDE (OUTFITTER_IDE=1 and the listener)", async () => {
    assert.equal(loadExtension().tools.has("vscode"), false, "desktop");
    process.env.OUTFITTER_PREVIEW_PORT = "4000";
    process.env.OUTFITTER_PREVIEW_TOKEN = "t";
    assert.equal(loadExtension().tools.has("vscode"), false, "a Drive without the IDE");
    process.env.OUTFITTER_IDE = "1";
    assert.equal(loadExtension().tools.has("vscode"), true);
  });

  test("asks agentd with its token, and tells the model the link is the person's", async () => {
    const agentd = await fakeAgentd({ token: "tok", reply: () => ({ status: 202, json: { requested: true } }) });
    process.env.OUTFITTER_PREVIEW_PORT = String(agentd.port);
    process.env.OUTFITTER_PREVIEW_TOKEN = "tok";
    process.env.OUTFITTER_IDE = "1";
    const { call } = loadExtension();
    const r = await call("vscode", {});
    assert.equal(r.isError, false);
    assert.match(r.text, /VS Code is starting/);
    assert.match(r.text, /owner/);
    assert.doesNotMatch(r.text, /https?:\/\//, "no link for the model");
    assert.deepEqual(agentd.calls.map((c) => [c.method, c.url, c.token]), [["POST", "/ide", "tok"]]);
  });

  test("a repeat inside agentd's window, and a Drive without the IDE, answer in plain words", async () => {
    let status = 429;
    const agentd = await fakeAgentd({
      token: "tok",
      reply: () => (status === 429 ? { status, json: { error: "too-many", detail: "asked a moment ago" } } : { status, json: { error: "not_found", detail: "this Drive has no IDE" } }),
    });
    process.env.OUTFITTER_PREVIEW_PORT = String(agentd.port);
    process.env.OUTFITTER_PREVIEW_TOKEN = "tok";
    process.env.OUTFITTER_IDE = "1";
    const { call } = loadExtension();
    const again = await call("vscode", {});
    assert.equal(again.isError, false);
    assert.match(again.text, /already on its way/);
    status = 404;
    const none = await call("vscode", {});
    assert.equal(none.isError, true);
    assert.match(none.text, /no VS Code/);
  });
});
