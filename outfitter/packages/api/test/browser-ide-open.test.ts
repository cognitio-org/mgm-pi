/**
 * Browser IDE phase 2 (#242, docs/specs/browser-ide.md §3-§4): opening the IDE from the session
 * page, the `ide.status` exchange with agentd, and the owner-only endpoint. The route rules use API
 * tokens as the owner, another person and a sysop; the flow uses a real agent socket.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, type TestApp } from "./helpers.ts";
import { openAgentSocket, makeRunningSession, sendHello, type SocketHandle } from "./agent-socket.ts";
import { FakeNgrok } from "./fake-ngrok.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { generateToken, hashToken, tokenPrefix } from "../src/tokens.ts";
import { ideInternalUrlFor, runLabel, MAX_OPEN_PREVIEWS_PER_RUN } from "../src/previews.ts";
import type { Run, Store } from "../src/store/types.ts";

const ENV = { PREVIEW_DOMAIN: "kernal.run", PREVIEW_ALLOW: "domain:example.com", OUTFITTER_OPERATORS: "sysop@example.com" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) return v;
    await sleep(20);
  }
}

// ---- route rules, with tokens ----

const RUN_ID = "3f2a9c1e-0000-4000-8000-00000000beef";
async function bearerFor(store: Store, email: string): Promise<Record<string, string>> {
  const token = generateToken();
  await store.tokens.insert({ id: crypto.randomUUID(), ownerEmail: email, name: "test", prefix: tokenPrefix(token), hash: hashToken(token), createdAt: new Date().toISOString() });
  return { authorization: `Bearer ${token}` };
}
async function routeSetup(runFields: Partial<Run> = { browserIde: true }, sessionOwner: string | null = "owner@example.com") {
  const store = new MemoryStore();
  const ngrok = new FakeNgrok();
  const app = await buildTestApp({ OUTFITTER_DEV: "0", ...ENV }, { store, ngrok });
  const now = new Date().toISOString();
  await store.sessions.insert({ id: "s1", guruId: "g", repo: null, status: "open", cost: 0, ...(sessionOwner ? { ownerEmail: sessionOwner } : {}), createdAt: now, updatedAt: now });
  await store.runs.insert({ id: RUN_ID, sessionId: "s1", state: "running", lastAckedSeq: 0, pending: [], createdAt: now, updatedAt: now, ...runFields } as unknown as Run);
  return { app, store, ngrok, owner: await bearerFor(store, "owner@example.com"), other: await bearerFor(store, "someone@example.com"), sysop: await bearerFor(store, "sysop@example.com") };
}
const post = (app: TestApp, headers: Record<string, string>) => app.fastify.inject({ method: "POST", url: "/api/sessions/s1/ide", headers });
const get = (app: TestApp, headers: Record<string, string>) => app.fastify.inject({ method: "GET", url: "/api/sessions/s1/ide", headers });

describe("IDE routes (#242)", () => {
  test("only the owner or a sysop may open it or see its state", async () => {
    const { app, store, owner, other, sysop } = await routeSetup();
    assert.equal((await post(app, other)).statusCode, 403);
    assert.equal((await get(app, other)).statusCode, 403);
    const opened = await post(app, owner);
    assert.equal(opened.statusCode, 202);
    assert.equal(opened.json().state, "requested");
    const run = await store.runs.findById(RUN_ID);
    assert.match(run?.ide?.reqId ?? "", /^[0-9a-f-]{36}$/);
    const queued = await store.runs.drainDownMessages(RUN_ID);
    assert.deepEqual(queued, [{ t: "ide.open", reqId: run!.ide!.reqId }], "queued for the link role's poller");
    assert.equal((await post(app, sysop)).statusCode, 202);
    assert.equal((await get(app, sysop)).json().available, true);
    await app.fastify.close();
  });

  test("refuses a Drive without the IDE, a floppy with no owner, and a Drive that isn't up", async () => {
    let s = await routeSetup({ browserIde: false });
    assert.equal((await post(s.app, s.owner)).statusCode, 409);
    assert.equal((await get(s.app, s.owner)).json().available, false);
    await s.app.fastify.close();
    s = await routeSetup({ browserIde: true }, null);
    const noOwner = await post(s.app, s.sysop);
    assert.equal(noOwner.statusCode, 409);
    assert.match(noOwner.json().error, /no owner/);
    await s.app.fastify.close();
    s = await routeSetup({ browserIde: true, state: "provisioning" } as Partial<Run>);
    assert.equal((await post(s.app, s.owner)).statusCode, 409);
    await s.app.fastify.close();
  });
});

// ---- the flow, with a real agent socket ----

async function flowSetup() {
  const ngrok = new FakeNgrok();
  const app = await buildTestApp(ENV, { ngrok });
  const { session, runId, runToken } = await makeRunningSession(app, { ownerEmail: "owner@example.com" });
  await app.store.gurus.update("test-guru", { browserIde: true });
  const agent = await openAgentSocket(app, runId);
  sendHello(agent, runId, session.id, runToken);
  const spec = await agent.nextMessage();
  assert.equal(spec.t, "run.spec");
  assert.ok(spec.ide, "the run has the IDE");
  agent.send({ t: "status", state: "idle" });
  await eventually(() => app.store.runs.findById(runId), (r) => r?.state === "idle");
  const internalUrl = ideInternalUrlFor(runLabel(runId));
  return { app, ngrok, agent, runId, internalUrl };
}
async function openAndGetReq(app: TestApp, agent: SocketHandle): Promise<string> {
  const res = await app.fastify.inject({ method: "POST", url: "/api/sessions/s1/ide" });
  assert.equal(res.statusCode, 202, res.body);
  const frame = await agent.nextMessage();
  assert.equal(frame.t, "ide.open");
  return frame.reqId;
}
const ideState = (app: TestApp) => app.fastify.inject({ method: "GET", url: "/api/sessions/s1/ide" }).then((r) => r.json());
async function done(app: TestApp, agent: SocketHandle) {
  agent.send({ t: "bye", reason: "stop" });
  await agent.nextClose();
  app.stopBackgroundTasks();
  await app.fastify.close();
}

describe("the ide.status exchange (#242)", () => {
  test("open → installing → ready makes an owner-and-sysop endpoint; the IDE isn't a preview chip or shareable", async () => {
    const { app, ngrok, agent, runId, internalUrl } = await flowSetup();
    const reqId = await openAndGetReq(app, agent);
    agent.send({ t: "ide.status", reqId, state: "installing" });
    assert.equal((await eventually(() => ideState(app), (s) => s.state === "installing")).state, "installing");
    agent.send({ t: "ide.status", reqId, state: "ready", internalUrl });
    const ready = await eventually(() => ideState(app), (s) => s.state === "ready");
    assert.match(ready.url, /^https:\/\/[0-9a-f]{32}\.kernal\.run$/);

    const ep = [...ngrok.endpoints.values()].find((e) => e.url === ready.url)!;
    assert.ok(ep, "a cloud endpoint for the IDE");
    const policy = JSON.parse(ep.trafficPolicy);
    const text = JSON.stringify(policy);
    assert.ok(text.includes("owner@example.com") && text.includes("sysop@example.com"), "owner and sysops");
    assert.ok(!text.includes("endsWith('@example.com')"), "not PREVIEW_ALLOW's domain:example.com rule");
    assert.ok(text.includes(internalUrl), "forwards to the run's IDE endpoint");

    const chips = (await app.fastify.inject({ method: "GET", url: "/api/sessions/s1/previews" })).json();
    assert.equal(chips.previews.length, 0, "not listed with dev-server previews");
    const share = await app.fastify.inject({ method: "POST", url: "/api/sessions/s1/previews/0/share", payload: {} });
    assert.equal(share.statusCode, 400, "port 0 can't be shared");

    // Opening again while ready answers at once, without a new request to agentd.
    const again = await app.fastify.inject({ method: "POST", url: "/api/sessions/s1/ide" });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().url, ready.url);
    assert.equal((await app.store.previews.listOpenForRun(runId)).filter((p) => p.kind === "ide").length, 1);
    await done(app, agent);
  });

  test("a frame for another request, or for the wrong internal endpoint, makes nothing", async () => {
    const { app, ngrok, agent, internalUrl } = await flowSetup();
    const reqId = await openAndGetReq(app, agent);
    agent.send({ t: "ide.status", reqId: "made-up", state: "ready", internalUrl });
    agent.send({ t: "ide.status", state: "ready", internalUrl });
    await sleep(150);
    assert.equal(ngrok.endpoints.size, 0, "no endpoint for a request the api didn't make");
    assert.equal((await ideState(app)).state, "requested");
    agent.send({ t: "ide.status", reqId, state: "ready", internalUrl: internalUrl.replace("https://ide.", "https://p3000.") });
    const bad = await eventually(() => ideState(app), (s) => s.state === "error");
    assert.equal(bad.state, "error");
    assert.equal(ngrok.endpoints.size, 0);
    await done(app, agent);
  });

  test("stopped closes the endpoint; the next open starts over", async () => {
    const { app, ngrok, agent, internalUrl } = await flowSetup();
    const reqId = await openAndGetReq(app, agent);
    agent.send({ t: "ide.status", reqId, state: "ready", internalUrl });
    await eventually(() => ideState(app), (s) => s.state === "ready");
    agent.send({ t: "ide.status", state: "stopped", detail: "code-server exited" });
    const stopped = await eventually(() => ideState(app), (s) => s.state === "stopped");
    assert.equal(stopped.state, "stopped");
    assert.equal(stopped.url, undefined);
    assert.equal(ngrok.endpoints.size, 0);
    const reqId2 = await openAndGetReq(app, agent);
    assert.notEqual(reqId2, reqId);
    await done(app, agent);
  });

  test("DELETE closes the public endpoint only; opening again makes a fresh one", async () => {
    const { app, ngrok, agent, internalUrl } = await flowSetup();
    const reqId = await openAndGetReq(app, agent);
    agent.send({ t: "ide.status", reqId, state: "ready", internalUrl });
    const first = await eventually(() => ideState(app), (s) => s.state === "ready");
    const del = await app.fastify.inject({ method: "DELETE", url: "/api/sessions/s1/ide" });
    assert.equal(del.statusCode, 204);
    assert.equal(ngrok.endpoints.size, 0);
    assert.equal((await ideState(app)).state, "closed");
    const reqId2 = await openAndGetReq(app, agent);
    agent.send({ t: "ide.status", reqId: reqId2, state: "ready", internalUrl });
    const second = await eventually(() => ideState(app), (s) => s.state === "ready");
    assert.notEqual(second.url, first.url);
    await done(app, agent);
  });

  test("the model's previews can't crowd out the IDE, and the IDE doesn't use up their slots", async () => {
    const { app, agent, runId, internalUrl } = await flowSetup();
    const reqId = await openAndGetReq(app, agent);
    agent.send({ t: "ide.status", reqId, state: "ready", internalUrl });
    await eventually(() => ideState(app), (s) => s.state === "ready");
    for (let i = 0; i < MAX_OPEN_PREVIEWS_PER_RUN; i++) {
      const r = await app.previews.open(runId, 3000 + i, false);
      assert.ok(!("error" in r), `preview ${i + 1} of ${MAX_OPEN_PREVIEWS_PER_RUN} opens beside the IDE`);
    }
    await done(app, agent);
  });
});

/** An ngrok API whose endpoint creation waits until released, to line up races. */
class GatedNgrok extends FakeNgrok {
  private gate: Promise<void> | undefined;
  private release: (() => void) | undefined;
  hold() { this.gate = new Promise((r) => { this.release = r; }); }
  open() { this.release?.(); this.gate = undefined; }
  override async createCloudEndpoint(input: Parameters<FakeNgrok["createCloudEndpoint"]>[0]) {
    if (this.gate) await this.gate;
    return super.createCloudEndpoint(input);
  }
}
async function gatedSetup(env: Record<string, string> = ENV) {
  const ngrok = new GatedNgrok();
  const app = await buildTestApp(env, { ngrok });
  const { session, runId, runToken } = await makeRunningSession(app, { ownerEmail: "owner@example.com" });
  await app.store.gurus.update("test-guru", { browserIde: true });
  const agent = await openAgentSocket(app, runId);
  sendHello(agent, runId, session.id, runToken);
  await agent.nextMessage();
  agent.send({ t: "status", state: "idle" });
  await eventually(() => app.store.runs.findById(runId), (r) => r?.state === "idle");
  return { app, ngrok, agent, runId, internalUrl: ideInternalUrlFor(runLabel(runId)) };
}

describe("IDE races (#242 review)", () => {
  test("a ready that arrives after the person closed it makes nothing", async () => {
    const { app, ngrok, agent, internalUrl } = await gatedSetup();
    const reqId = await openAndGetReq(app, agent);
    agent.send({ t: "ide.status", reqId, state: "installing" });
    await eventually(() => ideState(app), (s) => s.state === "installing");
    assert.equal((await app.fastify.inject({ method: "DELETE", url: "/api/sessions/s1/ide" })).statusCode, 204);
    agent.send({ t: "ide.status", reqId, state: "starting" });
    agent.send({ t: "ide.status", reqId, state: "ready", internalUrl });
    await sleep(150);
    assert.equal(ngrok.endpoints.size, 0);
    assert.equal((await ideState(app)).state, "closed", "late frames don't reopen it");
    await done(app, agent);
  });

  test("closing while the endpoint is being made removes it once made", async () => {
    const { app, ngrok, agent, internalUrl } = await gatedSetup();
    const reqId = await openAndGetReq(app, agent);
    ngrok.hold();
    agent.send({ t: "ide.status", reqId, state: "ready", internalUrl });
    await sleep(100);
    assert.equal((await app.fastify.inject({ method: "DELETE", url: "/api/sessions/s1/ide" })).statusCode, 204);
    ngrok.open();
    await eventually(async () => ngrok.endpoints.size, (n) => n === 0);
    await sleep(100);
    assert.equal(ngrok.endpoints.size, 0, "no orphan endpoint");
    const s = await ideState(app);
    assert.equal(s.state, "closed");
    assert.equal(s.url, undefined, "no dead URL");
    await done(app, agent);
  });

  test("two clicks answered together share one endpoint", async () => {
    const { app, ngrok, agent, runId, internalUrl } = await gatedSetup();
    const reqA = await openAndGetReq(app, agent);
    ngrok.hold();
    agent.send({ t: "ide.status", reqId: reqA, state: "ready", internalUrl });
    await sleep(80);
    const reqB = await openAndGetReq(app, agent);
    agent.send({ t: "ide.status", reqId: reqB, state: "ready", internalUrl });
    await sleep(80);
    ngrok.open();
    const ready = await eventually(() => ideState(app), (s) => s.state === "ready");
    await sleep(100);
    assert.equal(ngrok.endpoints.size, 1, "one endpoint for the run");
    assert.equal([...ngrok.endpoints.values()][0]!.url, ready.url);
    assert.equal((await app.store.previews.listOpenForRun(runId)).filter((p) => p.kind === "ide").length, 1);
    await done(app, agent);
  });

  test("a domain: entry on the operators list doesn't let a domain into the IDE", async () => {
    const { app, ngrok, agent, internalUrl } = await gatedSetup({ ...ENV, OUTFITTER_OPERATORS: "sysop@example.com,domain:evil.example" });
    const reqId = await openAndGetReq(app, agent);
    agent.send({ t: "ide.status", reqId, state: "ready", internalUrl });
    await eventually(() => ideState(app), (s) => s.state === "ready");
    const policy = [...ngrok.endpoints.values()][0]!.trafficPolicy;
    assert.ok(policy.includes("sysop@example.com") && policy.includes("owner@example.com"));
    assert.ok(!policy.includes("evil.example"), "no domain rule from the operators list");
    await done(app, agent);
  });

  test("an open click asks again when the recorded endpoint is gone", async () => {
    const { app, ngrok, agent, runId, internalUrl } = await gatedSetup();
    const reqId = await openAndGetReq(app, agent);
    agent.send({ t: "ide.status", reqId, state: "ready", internalUrl });
    await eventually(() => ideState(app), (s) => s.state === "ready");
    // The endpoint disappears behind the run's back (as a sweep or an ngrok-side delete would).
    for (const p of await app.store.previews.listOpenForRun(runId)) await app.store.previews.markClosed(p.id, new Date().toISOString(), "gone");
    ngrok.endpoints.clear();
    const res = await app.fastify.inject({ method: "POST", url: "/api/sessions/s1/ide" });
    assert.equal(res.statusCode, 202, "not the dead URL");
    assert.equal((await agent.nextMessage()).t, "ide.open");
    await done(app, agent);
  });
});
