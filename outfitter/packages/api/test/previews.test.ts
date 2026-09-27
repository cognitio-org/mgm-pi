/**
 * Drive previews, the api side (#217): the ngrok API client, the Traffic Policies, PreviewService
 * against a fake ngrok, and the agentlink wiring (run.spec, preview.open/close, bye). No network.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { createNgrokApi, NgrokApiError, type NgrokApi, type NgrokCredential, type NgrokEndpoint } from "../src/ngrok-api.ts";
import {
  MAX_OPEN_PREVIEWS_PER_RUN, ORPHAN_GRACE_MS, PreviewService, allowExpression, internalUrlFor, parseAllowlist, runLabel,
  securePolicy, sharePolicy, validPreviewPort,
} from "../src/previews.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Run } from "../src/store/types.ts";
import { buildTestApp } from "./helpers.ts";
import { openAgentSocket, makeRunningSession, sendHello } from "./agent-socket.ts";

class FakeNgrok implements NgrokApi {
  credentials = new Map<string, NgrokCredential>();
  endpoints = new Map<string, NgrokEndpoint & { trafficPolicy: string }>();
  deletedCredentials: string[] = [];
  deletedEndpoints: string[] = [];
  failCreateEndpoint = false;
  private seq = 0;
  async createCredential(input: { description: string; metadata: string; acl: string[] }) {
    const id = `cr_${++this.seq}`;
    const cred = { id, token: `tok_${id}`, ...input };
    this.credentials.set(id, { ...cred, token: undefined });
    return cred;
  }
  async deleteCredential(id: string) { this.deletedCredentials.push(id); this.credentials.delete(id); }
  async listCredentials() { return [...this.credentials.values()]; }
  async createCloudEndpoint(input: { url: string; trafficPolicy: string; description: string; metadata: string }) {
    if (this.failCreateEndpoint) throw new NgrokApiError(400, "ERR_NGROK_18002", "bad policy");
    const id = `ep_${++this.seq}`;
    const ep = { id, type: "cloud", url: input.url, description: input.description, metadata: input.metadata, trafficPolicy: input.trafficPolicy };
    this.endpoints.set(id, ep);
    return ep;
  }
  async deleteEndpoint(id: string) { this.deletedEndpoints.push(id); this.endpoints.delete(id); }
  async listCloudEndpoints() { return [...this.endpoints.values()]; }
}

function config(extra: Record<string, string> = {}) {
  return loadConfig({ PREVIEW_DOMAIN: "kernal.run", NGROK_API_KEY: "k", PREVIEW_ALLOW: "domain:mgms.eu;user:matija.turk@gmail.com", ...extra } as NodeJS.ProcessEnv);
}

async function liveRun(store: MemoryStore, id = "3f2a9c1e-0000-4000-8000-000000000001", state: Run["state"] = "running"): Promise<Run> {
  const now = new Date().toISOString();
  const run = { id, sessionId: "s1", state, lastAckedSeq: 0, pending: [], createdAt: now, updatedAt: now } as unknown as Run;
  await store.runs.insert(run);
  return run;
}

describe("ngrok API client", () => {
  test("sends the key and version, pages lists, treats a missing resource as deleted, maps errors", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const responses: Array<{ status: number; body: any }> = [
      { status: 200, body: { endpoints: [{ id: "ep_1", type: "cloud", url: "https://a.kernal.run" }, { id: "ep_2", type: "agent", url: "https://x.internal" }], next_page_uri: "https://api.ngrok.com/endpoints?limit=100&before_id=ep_2" } },
      { status: 200, body: { endpoints: [{ id: "ep_3", type: "cloud", url: "https://b.kernal.run" }], next_page_uri: null } },
      { status: 404, body: { error_code: "ERR_NGROK_404" } },
      { status: 400, body: { error_code: "ERR_NGROK_620", msg: "Only Pay-as-you-go plans can use tunnel ACL rules." } },
    ];
    const fetchImpl = (async (url: string, init: any) => {
      calls.push({ url, init });
      const r = responses.shift()!;
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch;
    const api = createNgrokApi("secret-key", fetchImpl);
    const eps = await api.listCloudEndpoints();
    assert.deepEqual(eps.map((e) => e.id), ["ep_1", "ep_3"]);
    assert.equal(calls[0].url, "https://api.ngrok.com/endpoints?limit=100");
    assert.equal(calls[0].init.headers.Authorization, "Bearer secret-key");
    assert.equal(calls[0].init.headers["Ngrok-Version"], "2");
    assert.equal(calls[1].url, "https://api.ngrok.com/endpoints?limit=100&before_id=ep_2");
    await api.deleteEndpoint("ep_gone");
    await assert.rejects(api.createCredential({ description: "d", metadata: "{}", acl: ["bind:*.r1.internal"] }),
      (e: any) => e instanceof NgrokApiError && e.status === 400 && e.code === "ERR_NGROK_620" && /Pay-as-you-go/.test(e.message));
    assert.deepEqual(JSON.parse(calls[3].init.body), { description: "d", metadata: "{}", acl: ["bind:*.r1.internal"] });
  });
});

describe("policies", () => {
  test("labels, internal URLs and ports", () => {
    assert.equal(runLabel("3F2A9C1E-0000-4000-8000-000000000001"), "r3f2a9c1e000040008000000000000001");
    assert.equal(internalUrlFor("rabc", 3000), "https://p3000.rabc.internal");
    assert.equal(validPreviewPort(3000), true);
    assert.equal(validPreviewPort(80), false);
    assert.equal(validPreviewPort(65536), false);
  });

  test("the allowlist keeps only strictly-shaped emails and domains (it becomes CEL)", () => {
    const a = parseAllowlist(["domain:mgms.eu", "user:Matija.Turk@gmail.com", "mgm@mgms.eu", "group:eng@mgms.eu", "x' || true || 'y@a.com", "domain:a' || true", ""]);
    assert.deepEqual(a.emails, ["matija.turk@gmail.com", "mgm@mgms.eu"]);
    assert.deepEqual(a.domains, ["mgms.eu"]);
    assert.deepEqual(a.ignored, ["group:eng@mgms.eu", "x' || true || 'y@a.com", "domain:a' || true"]);
    assert.equal(allowExpression(a), "actions.ngrok.oauth.identity.email in ['matija.turk@gmail.com', 'mgm@mgms.eu'] || actions.ngrok.oauth.identity.email.endsWith('@mgms.eu')");
    assert.equal(allowExpression({ emails: [], domains: [] }), "false", "nobody allowed means nobody gets in");
  });

  test("secure: Google sign-in, deny unless allowed, forward; our client carries the email scope", () => {
    const allow = { emails: ["a@b.com"], domains: ["mgms.eu"] };
    const managed = JSON.parse(securePolicy("https://p3000.rabc.internal", allow));
    assert.deepEqual(managed.on_http_request[0].actions[0], { type: "oauth", config: { provider: "google" } });
    assert.equal(managed.on_http_request[1].expressions[0], `!(${allowExpression(allow)})`);
    assert.deepEqual(managed.on_http_request[1].actions[0], { type: "deny", config: { status_code: 403 } });
    assert.deepEqual(managed.on_http_request[2].actions[0], { type: "forward-internal", config: { url: "https://p3000.rabc.internal" } });
    assert.equal(managed.on_http_response[0].actions[0].config.headers["x-robots-tag"], "noindex, nofollow");
    const own = JSON.parse(securePolicy("https://p3000.rabc.internal", allow, { clientId: "cid", clientSecret: "cs" }));
    assert.deepEqual(own.on_http_request[0].actions[0].config, {
      provider: "google", client_id: "cid", client_secret: "cs", scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email"],
    });
  });

  test("share: a notice until acknowledged (cookie lives until the link expires), then forward", () => {
    const now = new Date("2026-09-28T10:00:00Z");
    const p = JSON.parse(sharePolicy("https://p3000.rabc.internal", "2026-09-29T10:00:00.000Z", now));
    const [ack, notice, fwd] = p.on_http_request;
    assert.equal(ack.expressions[0], "'kernal_preview_ack' in req.url.query_params");
    assert.equal(ack.actions[0].config.status_code, 302);
    assert.match(ack.actions[0].config.headers["set-cookie"], /^kernal_preview_ack=1; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400$/);
    assert.equal(notice.expressions[0], "!('kernal_preview_ack' in req.cookies)");
    assert.match(notice.actions[0].config.body, /AI agent/);
    assert.match(notice.actions[0].config.body, /2026-09-29 10:00 UTC/);
    assert.deepEqual(fwd.actions[0], { type: "forward-internal", config: { url: "https://p3000.rabc.internal" } });
  });
});

describe("PreviewService", () => {
  test("off without PREVIEW_DOMAIN or ngrok", async () => {
    const store = new MemoryStore();
    const run = await liveRun(store);
    const noDomain = new PreviewService({ store, config: config({ PREVIEW_DOMAIN: "" }), ngrok: new FakeNgrok() });
    assert.equal(noDomain.enabled, false);
    assert.equal(await noDomain.runSpecConfig(run), undefined);
    assert.deepEqual(await noDomain.open(run.id, 3000, false), { error: "not-configured" });
    assert.equal(new PreviewService({ store, config: config() }).enabled, false);
  });

  test("the run's credential is minted once, restricted to its own internal names, and reused on reconnect", async () => {
    const store = new MemoryStore();
    const ngrok = new FakeNgrok();
    const svc = new PreviewService({ store, config: config(), ngrok });
    const run = await liveRun(store);
    const first = await svc.runSpecConfig(run);
    const label = runLabel(run.id);
    assert.deepEqual(first, { internalDomain: `${label}.internal`, token: "tok_cr_1" });
    const cred = [...ngrok.credentials.values()][0];
    assert.deepEqual(cred.acl, [`bind:*.${label}.internal`]);
    assert.equal(JSON.parse(cred.metadata!).runId, run.id);
    assert.deepEqual((await store.runs.findById(run.id))?.preview, { label, credentialId: "cr_1" });
    assert.deepEqual(await svc.runSpecConfig(run), { internalDomain: `${label}.internal` }, "no token, no second credential");
    assert.equal(ngrok.credentials.size, 1);
  });

  test("open makes a random host on the preview domain with the right policy, idempotently; share is separate and expires", async () => {
    const store = new MemoryStore();
    const ngrok = new FakeNgrok();
    const now = new Date("2026-09-28T10:00:00Z");
    const svc = new PreviewService({ store, config: config({ NGROK_GOOGLE_OAUTH: JSON.stringify({ client_id: "cid", client_secret: "cs" }) }), ngrok, now: () => now });
    const run = await liveRun(store);
    await svc.runSpecConfig(run);
    const internal = internalUrlFor(runLabel(run.id), 3000);
    const secure = await svc.open(run.id, 3000, false, internal);
    assert.ok("url" in secure);
    assert.match(secure.url, /^https:\/\/[0-9a-f]{32}\.kernal\.run$/);
    const ep = [...ngrok.endpoints.values()][0];
    const policy = JSON.parse(ep.trafficPolicy);
    assert.equal(policy.on_http_request[0].actions[0].config.client_id, "cid");
    assert.match(policy.on_http_request[1].expressions[0], /endsWith\('@mgms\.eu'\)/);
    assert.equal(policy.on_http_request[2].actions[0].config.url, internal);
    assert.deepEqual(await svc.open(run.id, 3000, false), secure, "same port and mode: same preview");
    const share = await svc.open(run.id, 3000, true);
    assert.ok("url" in share && share.url !== secure.url);
    assert.equal((share as any).expiresAt, "2026-09-29T10:00:00.000Z");
    assert.equal(ngrok.endpoints.size, 2);
    assert.equal((await store.previews.listOpenForSession("s1")).length, 2);
  });

  test("open refuses a bad port, a dead run, a mismatched internal URL, and too many previews", async () => {
    const store = new MemoryStore();
    const ngrok = new FakeNgrok();
    const svc = new PreviewService({ store, config: config(), ngrok });
    const run = await liveRun(store);
    await svc.runSpecConfig(run);
    assert.deepEqual(await svc.open(run.id, 80, false), { error: "port-not-allowed" });
    assert.deepEqual(await svc.open(run.id, 3000, false, "https://p3000.rother.internal"), { error: "failed" });
    assert.deepEqual(await svc.open("no-such-run", 3000, false), { error: "not-configured" });
    for (let i = 0; i < MAX_OPEN_PREVIEWS_PER_RUN; i++) assert.ok("url" in (await svc.open(run.id, 4000 + i, false)));
    assert.deepEqual(await svc.open(run.id, 5000, false), { error: "too-many" });
    const dead = await liveRun(store, "3f2a9c1e-0000-4000-8000-000000000002", "stopped");
    await store.runs.update(dead.id, { preview: { label: runLabel(dead.id), credentialId: "cr_x" } });
    assert.deepEqual(await svc.open(dead.id, 3000, false), { error: "not-configured" });
  });

  test("an ngrok failure answers failed and records nothing", async () => {
    const store = new MemoryStore();
    const ngrok = new FakeNgrok();
    const svc = new PreviewService({ store, config: config(), ngrok });
    const run = await liveRun(store);
    await svc.runSpecConfig(run);
    ngrok.failCreateEndpoint = true;
    assert.deepEqual(await svc.open(run.id, 3000, false), { error: "failed" });
    assert.equal((await store.previews.listOpen()).length, 0);
  });

  test("close removes a port's previews; closeRun removes the rest and the credential", async () => {
    const store = new MemoryStore();
    const ngrok = new FakeNgrok();
    const svc = new PreviewService({ store, config: config(), ngrok });
    const run = await liveRun(store);
    await svc.runSpecConfig(run);
    await svc.open(run.id, 3000, false);
    await svc.open(run.id, 3000, true);
    await svc.open(run.id, 4000, false);
    await svc.close(run.id, 3000);
    assert.equal(ngrok.endpoints.size, 1);
    assert.deepEqual((await store.previews.listOpenForRun(run.id)).map((p) => p.port), [4000]);
    await svc.closeRun(run.id);
    assert.equal(ngrok.endpoints.size, 0);
    assert.deepEqual(ngrok.deletedCredentials, ["cr_1"]);
    await svc.closeRun(run.id); // idempotent
  });

  test("sweep: expired share links, previews of runs that ended, ngrok orphans past the grace; nothing live or foreign", async () => {
    const store = new MemoryStore();
    const ngrok = new FakeNgrok();
    let now = new Date("2026-09-28T10:00:00Z");
    const svc = new PreviewService({ store, config: config(), ngrok, now: () => now });
    const live = await liveRun(store);
    const ending = await liveRun(store, "3f2a9c1e-0000-4000-8000-000000000003");
    await svc.runSpecConfig(live);
    await svc.runSpecConfig(ending);
    const keep = await svc.open(live.id, 3000, false);
    await svc.open(live.id, 3000, true);
    await svc.open(ending.id, 3000, false);
    await store.runs.update(ending.id, { state: "failed" });
    // a crash between creating an endpoint and recording it, a foreign endpoint, and one just made
    const orphanMeta = (createdAt: string) => JSON.stringify({ purpose: "outfitter-preview", createdAt });
    ngrok.endpoints.set("ep_orphan", { id: "ep_orphan", type: "cloud", url: "https://dead.kernal.run", metadata: orphanMeta("2026-09-28T09:00:00Z"), trafficPolicy: "{}" });
    ngrok.endpoints.set("ep_young", { id: "ep_young", type: "cloud", url: "https://young.kernal.run", metadata: orphanMeta(new Date(now.getTime() + 25 * 3600_000 - ORPHAN_GRACE_MS / 2).toISOString()), trafficPolicy: "{}" });
    ngrok.endpoints.set("ep_foreign", { id: "ep_foreign", type: "cloud", url: "https://mgm-lmstudio.ngrok.app", metadata: "", trafficPolicy: "{}" });
    ngrok.credentials.set("cr_other", { id: "cr_other", metadata: JSON.stringify({ purpose: "something-else" }) });
    now = new Date(now.getTime() + 25 * 3600_000); // past the share link's 24 h
    const out = await svc.sweep();
    assert.deepEqual(out, { expired: 1, deadRuns: 1, orphanEndpoints: 1, credentials: 1 });
    assert.ok(ngrok.endpoints.has("ep_young") && ngrok.endpoints.has("ep_foreign"));
    assert.ok(!ngrok.endpoints.has("ep_orphan"));
    assert.deepEqual((await store.previews.listOpen()).map((p) => p.url), ["url" in keep ? keep.url : ""]);
    assert.deepEqual(ngrok.deletedCredentials, ["cr_2"], "the ended run's credential; the live run's and the unrelated one stay");
    assert.ok(ngrok.credentials.has("cr_1") && ngrok.credentials.has("cr_other"));
  });
});

describe("agentlink wiring", () => {
  const env = { PREVIEW_DOMAIN: "kernal.run", PREVIEW_ALLOW: "domain:mgms.eu" };

  test("run.spec carries the preview config; preview.open is answered with the URL; bye removes it all", async () => {
    const ngrok = new FakeNgrok();
    const app = await buildTestApp(env, { ngrok });
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    const spec = await agent.nextMessage();
    assert.equal(spec.t, "run.spec");
    const label = runLabel(runId);
    assert.deepEqual(spec.preview, { internalDomain: `${label}.internal` });
    assert.equal(spec.secrets.ngrokAuthtoken, "tok_cr_1");

    agent.send({ t: "preview.open", requestId: "q1", port: 3000, internalUrl: internalUrlFor(label, 3000), share: false });
    const result = await agent.nextMessage();
    assert.equal(result.t, "preview.result");
    assert.equal(result.requestId, "q1");
    assert.match(result.url, /^https:\/\/[0-9a-f]{32}\.kernal\.run$/);

    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    for (let i = 0; i < 50 && ngrok.deletedCredentials.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(ngrok.endpoints.size, 0);
    assert.deepEqual(ngrok.deletedCredentials, ["cr_1"]);
    app.stopBackgroundTasks();
    await app.fastify.close();
  });

  test("without PREVIEW_DOMAIN: no preview config, and an open is not-configured", async () => {
    const ngrok = new FakeNgrok();
    const app = await buildTestApp({}, { ngrok });
    const { session, runId, runToken } = await makeRunningSession(app);
    const agent = await openAgentSocket(app, runId);
    sendHello(agent, runId, session.id, runToken);
    const spec = await agent.nextMessage();
    assert.equal(spec.preview, undefined);
    assert.equal(spec.secrets.ngrokAuthtoken, undefined);
    agent.send({ t: "preview.open", requestId: "q1", port: 3000, share: false });
    const result = await agent.nextMessage();
    assert.deepEqual({ t: result.t, error: result.error }, { t: "preview.result", error: "not-configured" });
    assert.equal(ngrok.credentials.size, 0);
    agent.send({ t: "bye", reason: "stop" });
    await agent.nextClose();
    app.stopBackgroundTasks();
    await app.fastify.close();
  });
});
