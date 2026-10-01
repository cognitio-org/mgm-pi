// E9 PR2 (#308, docs/specs/atlas-agent-engine-and-a2a.md §2): the Agent Engine client against the
// fake -- token cache and refresh, one refresh in flight, 429 back-off, 401 refresh-once, typed
// errors, two projects -- plus the memory SDK through our fetchImpl, the agents routes, and config.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AgentEngineClient, AgentEngineError, createAgentEngine, toAgentEngineError } from "../src/agentengine/index.ts";
import { FAKE_PROJECTS, FakeAgentEngine } from "./fake-agent-engine.ts";
import { sdkFetch } from "../src/agentengine/memory.ts";
import { AGENT_ENGINE_DEFAULT_BASE_URL, agentEngineExpiryWarning, agentEngineWarnings, loadConfig } from "../src/config.ts";

function clock(start = Date.parse("2026-10-01T00:00:00Z")) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function clientFor(fake: FakeAgentEngine, opts: Partial<ConstructorParameters<typeof AgentEngineClient>[0]> = {}) {
  return new AgentEngineClient({ part: "memory", baseUrl: fake.baseUrl, project: { ...FAKE_PROJECTS.memory }, fetch: fake.fetch, ...opts });
}

async function rejectsWith(p: Promise<unknown>, kind: string): Promise<AgentEngineError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof AgentEngineError, String(err));
    assert.equal(err.kind, kind, err.message);
    return err;
  }
  assert.fail(`expected ${kind}`);
}

describe("token", () => {
  test("Basic credentials and the client_credentials form; cached until 5 min before expiry", async () => {
    const c = clock();
    const fake = new FakeAgentEngine({ now: c.now });
    const client = clientFor(fake, { now: c.now });
    const first = await client.token();
    const req = fake.requests[0];
    assert.equal(req.method, "POST");
    assert.equal(req.path, "/api/v1/oauth/token");
    assert.equal(req.body, "grant_type=client_credentials");
    assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded");
    assert.equal(req.authorization, `Basic ${Buffer.from("ae_sa_id_memory:ae_sa_sk_memory").toString("base64")}`);
    c.advance(54 * 60_000);
    assert.equal(await client.token(), first, "still fresh at 54 min");
    c.advance(2 * 60_000);
    const second = await client.token();
    assert.notEqual(second, first, "refreshed inside the 5 min skew");
    assert.equal(fake.tokenRequests(), 2);
  });

  test("one refresh in flight: concurrent callers share it", async () => {
    const fake = new FakeAgentEngine();
    fake.tokenDelayMs = 20;
    const client = clientFor(fake);
    const tokens = await Promise.all(Array.from({ length: 8 }, () => client.token()));
    assert.equal(new Set(tokens).size, 1);
    assert.equal(fake.tokenRequests(), 1);
  });

  test("429: rate_limited with Retry-After, and no further token request until it has passed", async () => {
    const c = clock();
    const fake = new FakeAgentEngine({ now: c.now });
    fake.tokenFailures.push({ status: 429, retryAfter: 7 });
    const client = clientFor(fake, { now: c.now });
    const err = await rejectsWith(client.token(), "rate_limited");
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 7000);
    c.advance(3000);
    const again = await rejectsWith(client.token(), "rate_limited");
    assert.equal(again.retryAfterMs, 4000);
    assert.equal(fake.tokenRequests(), 1, "the cool-down asks nobody");
    c.advance(4000);
    assert.match(await client.token(), /^fake_at_/);
    assert.equal(fake.tokenRequests(), 2);
  });

  test("429 without Retry-After backs off for the default", async () => {
    const c = clock();
    const fake = new FakeAgentEngine({ now: c.now });
    fake.tokenFailures.push({ status: 429 });
    const client = clientFor(fake, { now: c.now, rateLimitBackoffMs: 30_000 });
    assert.equal((await rejectsWith(client.token(), "rate_limited")).retryAfterMs, 30_000);
    c.advance(29_000);
    await rejectsWith(client.token(), "rate_limited");
    assert.equal(fake.tokenRequests(), 1);
  });

  test("a wrong secret is auth, and no message ever carries the secret or a token", async () => {
    const fake = new FakeAgentEngine();
    const client = new AgentEngineClient({ part: "memory", baseUrl: fake.baseUrl, project: { ...FAKE_PROJECTS.memory, clientSecret: "ae_sa_sk_WRONG" }, fetch: fake.fetch });
    const err = await rejectsWith(client.token(), "auth");
    assert.equal(err.status, 401);
    assert.match(err.message, /outfitter-agentengine-memory-sa/);
    assert.doesNotMatch(err.message + String(err.stack), /ae_sa_sk|ae_sa_id/);
  });

  test("a network failure and an unreadable reply are typed too", async () => {
    const down = new AgentEngineClient({ part: "agents", baseUrl: "https://elsewhere.fake", project: { ...FAKE_PROJECTS.agents }, fetch: new FakeAgentEngine().fetch });
    await rejectsWith(down.token(), "network");
    const junk = new AgentEngineClient({
      part: "agents",
      baseUrl: "https://x.fake",
      project: { ...FAKE_PROJECTS.agents },
      fetch: async () => new Response(JSON.stringify({ token_type: "Bearer" }), { status: 200 }),
    });
    await rejectsWith(junk.token(), "server");
  });

  test("a short-lived token is used for half its life", async () => {
    const c = clock();
    const fake = new FakeAgentEngine({ now: c.now, tokenLifetimeSec: 120 });
    const client = clientFor(fake, { now: c.now });
    const first = await client.token();
    c.advance(59_000);
    assert.equal(await client.token(), first);
    c.advance(2_000);
    assert.notEqual(await client.token(), first);
  });
});

describe("calls", () => {
  test("Authorization from the cache; a 401 refreshes once and retries once", async () => {
    const fake = new FakeAgentEngine();
    fake.runtimeSessions.set("w1", [{ session_id: "s1", status: "active" }]);
    const ae = createAgentEngine(fake.config(), { fetch: fake.fetch });
    assert.deepEqual(await ae.agents!.listRuntimeSessions("w1"), [{ session_id: "s1", status: "active" }]);
    assert.equal(fake.tokenRequests(), 1);
    fake.revokeTokens();
    assert.equal((await ae.agents!.listRuntimeSessions("w1")).length, 1);
    assert.equal(fake.tokenRequests(), 2, "one refresh after the 401");
    const calls = fake.requests.filter((r) => r.path.endsWith("/runtime-sessions"));
    assert.equal(calls.length, 3);
    assert.notEqual(calls[1].authorization, calls[2].authorization);
  });

  test("a 401 that survives the refresh is auth, after exactly one retry", async () => {
    let n = 0;
    const fake = new FakeAgentEngine();
    const client = new AgentEngineClient({
      part: "agents",
      baseUrl: fake.baseUrl,
      project: { ...FAKE_PROJECTS.agents },
      fetch: async (url, init) => (url.endsWith("/oauth/token") ? fake.fetch(url, init) : (n++, new Response('{"detail":"nope"}', { status: 401 }))),
    });
    const err = await rejectsWith(client.request("GET", "/executions/e1"), "auth");
    assert.equal(n, 2);
    assert.match(err.message, /answered 401: nope/);
  });

  test("concurrent 401s cost one refresh", async () => {
    const fake = new FakeAgentEngine();
    fake.runtimeSessions.set("w1", []);
    const ae = createAgentEngine(fake.config(), { fetch: fake.fetch });
    await ae.agents!.listRuntimeSessions("w1");
    fake.revokeTokens();
    fake.tokenDelayMs = 10;
    await Promise.all(Array.from({ length: 5 }, () => ae.agents!.listRuntimeSessions("w1")));
    assert.equal(fake.tokenRequests(), 2);
  });

  test("two projects: separate tokens, and a token works only on its own project", async () => {
    const fake = new FakeAgentEngine();
    const memory = clientFor(fake);
    const agents = new AgentEngineClient({ part: "agents", baseUrl: fake.baseUrl, project: { ...FAKE_PROJECTS.agents }, fetch: fake.fetch });
    assert.notEqual(await memory.token(), await agents.token());
    const crossed = new AgentEngineClient({ part: "agents", baseUrl: fake.baseUrl, project: { ...FAKE_PROJECTS.memory, projectId: FAKE_PROJECTS.agents.projectId }, fetch: fake.fetch });
    const err = await rejectsWith(crossed.request("GET", "/executions/e1"), "auth");
    assert.equal(err.status, 403);
  });

  test("requests never follow a redirect", async () => {
    const seen: RequestInit[] = [];
    const fake = new FakeAgentEngine();
    const client = new AgentEngineClient({
      part: "memory",
      baseUrl: fake.baseUrl,
      project: { ...FAKE_PROJECTS.memory },
      fetch: async (url, init) => {
        seen.push(init);
        return fake.fetch(url, init);
      },
    });
    await client.request("POST", "/memory/turns", { body: { role: "user", content: "hi" } });
    assert.ok(seen.length >= 2);
    for (const init of seen) assert.equal(init.redirect, "error");
  });

  test("the token is never sent to another origin", async () => {
    const fake = new FakeAgentEngine();
    const client = clientFor(fake);
    await rejectsWith(client.fetch("https://evil.example/api/v1/projects/p/memory/turns", { method: "POST" }), "bad_request");
    assert.equal(fake.requests.length, 0);
  });

  test("a caller's abort ends its wait for a slow token without failing other callers", async () => {
    const fake = new FakeAgentEngine();
    fake.tokenDelayMs = 50;
    const client = clientFor(fake);
    const ac = new AbortController();
    const mine = client.fetch(client.projectUrl("/executions/e1"), { signal: ac.signal });
    const theirs = client.token();
    ac.abort();
    await assert.rejects(mine, (e: unknown) => (e as Error).name === "AbortError");
    assert.match(await theirs, /^fake_at_/);
    assert.equal(fake.tokenRequests(), 1);
  });

  test("status codes map to kinds; error text is clipped to one line", async () => {
    const fake = new FakeAgentEngine();
    const client = clientFor(fake);
    await rejectsWith(client.request("GET", "/executions/missing"), "not_found");
    const big = new AgentEngineClient({
      part: "memory",
      baseUrl: fake.baseUrl,
      project: { ...FAKE_PROJECTS.memory },
      fetch: async (url, init) => (url.endsWith("/oauth/token") ? fake.fetch(url, init) : new Response(`line one\n${"x".repeat(2000)}`, { status: 503 })),
    });
    const err = await rejectsWith(big.request("GET", "/x"), "server");
    assert.ok(err.message.length < 450, `${err.message.length}`);
    assert.doesNotMatch(err.message, /\n/);
  });
});

describe("memory (SDK 0.11.7 through our fetchImpl)", () => {
  test("recordTurn, saveSemantic and buildContext reach the project's routes with our token", async () => {
    const fake = new FakeAgentEngine();
    const { memory } = createAgentEngine(fake.config(["memory"]), { fetch: fake.fetch });
    assert.ok(memory);
    const me = memory.bind({ userId: "u1", sessionId: "sess-1" });
    const turn = await me.recordTurn({ role: "user", content: "hello", idempotencyKey: "entry-1" });
    assert.equal(turn.acknowledged, true);
    await me.saveSemantic({ text: "repo X runs npm run test:unit", label: "u1:_:tests", metadata: { repo: "o/x" } });
    const ctx = await me.buildContext({ query: "how are tests run?", maxTokens: 500 });
    assert.match(String(ctx.formatted_context), /npm run test:unit/);
    const prefix = `/api/v1/projects/${FAKE_PROJECTS.memory.projectId}/memory`;
    const api = fake.requests.filter((r) => r.path.startsWith(prefix));
    assert.deepEqual(api.map((r) => r.path.slice(prefix.length)), ["/turns", "/semantic", "/context"]);
    for (const r of api) assert.match(r.authorization ?? "", /^Bearer fake_at_/);
    assert.equal(fake.tokenRequests(), 1);
    assert.equal((fake.turns[0] as { user_id?: string }).user_id, "u1");
  });

  test("a revoked token: the SDK's call succeeds after one refresh", async () => {
    const fake = new FakeAgentEngine();
    const { memory } = createAgentEngine(fake.config(["memory"]), { fetch: fake.fetch });
    await memory!.bind({ userId: "u1" }).recordTurn({ role: "user", content: "a", sessionId: "s" });
    fake.revokeTokens();
    await memory!.bind({ userId: "u1" }).recordTurn({ role: "user", content: "b", sessionId: "s" });
    assert.equal(fake.tokenRequests(), 2);
    assert.equal(fake.turns.length, 2);
  });

  test("a rate-limited token reaches the caller as rate_limited, not a connection error", async () => {
    const fake = new FakeAgentEngine();
    fake.tokenFailures.push({ status: 429, retryAfter: 5 });
    const { memory } = createAgentEngine(fake.config(["memory"]), { fetch: fake.fetch });
    let caught: unknown;
    try {
      await memory!.bind({ userId: "u1" }).buildContext({ query: "q" });
    } catch (err) {
      caught = err;
    }
    const mapped = toAgentEngineError(caught);
    assert.equal(mapped.kind, "rate_limited");
    assert.equal(mapped.status, 429);
    assert.equal(fake.tokenRequests(), 1, "the SDK doesn't retry a 429");
  });

  test("sdkFetch turns a token failure into a reply with its status and Retry-After", async () => {
    const res = await sdkFetch({ fetch: async () => Promise.reject(new AgentEngineError("rate_limited", "slow down", { status: 429, retryAfterMs: 2500 })) })("https://x/y", {});
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "3");
    await assert.rejects(sdkFetch({ fetch: async () => Promise.reject(new TypeError("fetch failed")) })("https://x/y", {}), TypeError);
  });

  test("softDelete and contextFromSources go straight to the gateway routes", async () => {
    const fake = new FakeAgentEngine();
    const { memory } = createAgentEngine(fake.config(["memory"]), { fetch: fake.fetch });
    const saved = await memory!.bind({ userId: "u1" }).saveSemantic({ text: "t", label: "l" });
    const ctx = (await memory!.contextFromSources({ query: "q", user_id: "u1", sources: [{ source: "semantic", metadata_filter: { "metadata.repo": { $exists: false } } }] })) as { formatted_context: string };
    assert.equal(ctx.formatted_context, "- t");
    await memory!.softDelete("semantic", saved.id, "u1");
    const del = fake.requests.find((r) => r.method === "DELETE")!;
    assert.deepEqual(del.query, { soft: "true", user_id: "u1" });
    assert.equal(fake.semantic[0].deleted, true);
    await assert.rejects(memory!.softDelete("semantic", saved.id, "someone-else"), (e: unknown) => e instanceof AgentEngineError && e.kind === "not_found");
    const before = fake.requests.length;
    await rejectsWith(memory!.softDelete("semantic", "..", "u1"), "bad_request");
    await rejectsWith(memory!.softDelete("../oauth" as never, "x", "u1"), "bad_request");
    assert.equal(fake.requests.length, before, "refused before any request");
  });
});

describe("agents (PR4 completes invoke and resume)", () => {
  test("executions and runtime sessions; ids are checked before any request", async () => {
    const fake = new FakeAgentEngine();
    fake.executions.set("e1", { execution_id: "e1", status: "suspended", allowed_decisions: ["approve", "reject"] });
    fake.runtimeSessions.set("w1", [{ session_id: "outf-12345678-helper", status: "active" }]);
    const { agents } = createAgentEngine(fake.config(["agents"]), { fetch: fake.fetch });
    assert.deepEqual((await agents!.getExecution("w1", "e1")).allowed_decisions, ["approve", "reject"]);
    assert.equal(fake.requests.at(-1)!.query.workspace_id, "w1");
    await agents!.stopRuntimeSession("w1", "outf-12345678-helper");
    assert.equal(fake.runtimeSessions.get("w1")![0].status, "stopping");
    await rejectsWith(agents!.getExecution("w1", "../../oauth/token"), "bad_request");
    for (const dots of [".", "..", ".hidden"]) {
      await rejectsWith(agents!.getExecution("w1", dots), "bad_request");
      await rejectsWith(agents!.stopRuntimeSession(dots, "s"), "bad_request");
    }
    await rejectsWith(agents!.stopRuntimeSession("w/1", "s"), "bad_request");
    // PR4: invoke and resume are built (ae-agents.test.ts); their ids are checked the same way.
    const before = fake.requests.length;
    await rejectsWith(agents!.invoke({ workspaceId: "..", message: "hi", sessionId: "s", outfitterSession: "12345678" }), "bad_request");
    await rejectsWith(agents!.resume({ workspaceId: "w1", executionId: "../e1", decision: "approve", outfitterSession: "12345678" }), "bad_request");
    assert.equal(fake.requests.length, before);
  });

  test("off when unconfigured: no part, no requests", () => {
    const fake = new FakeAgentEngine();
    assert.deepEqual(createAgentEngine({ baseUrl: fake.baseUrl }, { fetch: fake.fetch }), {});
    const only = createAgentEngine(fake.config(["memory"]), { fetch: fake.fetch });
    assert.ok(only.memory && !only.agents);
    assert.equal(fake.requests.length, 0, "nothing is fetched eagerly");
  });
});

describe("config", () => {
  const SA = JSON.stringify({ client_id: "ae_sa_id_x", client_secret: "ae_sa_sk_x" });

  test("off by default, with the default base URL", () => {
    const c = loadConfig({});
    assert.deepEqual(c.agentEngine, { baseUrl: AGENT_ENGINE_DEFAULT_BASE_URL });
    assert.deepEqual(agentEngineWarnings(c, {}), []);
  });

  test("a part is on with its project id and readable credentials", () => {
    const c = loadConfig({
      AGENT_ENGINE_MEMORY_PROJECT_ID: " 6aafddf75566cf48726735bb ",
      AGENT_ENGINE_MEMORY_SA: SA,
      AGENT_ENGINE_MEMORY_SA_EXPIRES_AT: "2026-12-30T01:51:48Z",
    });
    assert.deepEqual(c.agentEngine.memory, { projectId: "6aafddf75566cf48726735bb", clientId: "ae_sa_id_x", clientSecret: "ae_sa_sk_x", expiresAt: "2026-12-30T01:51:48Z" });
    assert.equal(c.agentEngine.agents, undefined);
  });

  test("a project id without credentials stays off, and says so without quoting anything secret", () => {
    const env = { AGENT_ENGINE_AGENTS_PROJECT_ID: "p2", AGENT_ENGINE_AGENTS_SA: '{"client_id":"ae_sa_id_y"}' };
    const c = loadConfig(env);
    assert.equal(c.agentEngine.agents, undefined);
    const [w] = agentEngineWarnings(c, env);
    assert.match(w, /AGENT_ENGINE_AGENTS_SA is missing or isn't JSON/);
    assert.doesNotMatch(w, /ae_sa_id_y/);
    assert.equal(loadConfig({ AGENT_ENGINE_MEMORY_SA: SA }).agentEngine.memory, undefined, "credentials alone don't turn it on");
  });

  test("the base URL must be https (loopback http allowed for a fake)", () => {
    assert.throws(() => loadConfig({ AGENT_ENGINE_BASE_URL: "http://agentengine.example.com" }), /must be https/);
    assert.throws(() => loadConfig({ AGENT_ENGINE_BASE_URL: "https://user:pw@agentengine.example.com" }), /bare origin/);
    assert.throws(() => loadConfig({ AGENT_ENGINE_BASE_URL: "not a url" }), /invalid AGENT_ENGINE_BASE_URL/);
    assert.equal(loadConfig({ AGENT_ENGINE_BASE_URL: "http://127.0.0.1:9999/" }).agentEngine.baseUrl, "http://127.0.0.1:9999");
    assert.equal(loadConfig({ AGENT_ENGINE_BASE_URL: "https://agentengine.mongodb.com/" }).agentEngine.baseUrl, "https://agentengine.mongodb.com");
  });

  test("rotation warning: from 14 days before, and after expiry; unknown expiry is silent", () => {
    const at = "2026-12-30T01:51:48Z";
    const day = 24 * 60 * 60_000;
    const exp = Date.parse(at);
    assert.equal(agentEngineExpiryWarning("memory", at, exp - 15 * day), undefined);
    assert.match(agentEngineExpiryWarning("memory", at, exp - 14 * day)!, /outfitter-agentengine-memory-sa\) expires in 14 days /);
    assert.match(agentEngineExpiryWarning("agents", at, exp - day / 2)!, /expires in 1 day /);
    assert.match(agentEngineExpiryWarning("memory", at, exp + 1)!, /expired at 2026-12-30T01:51:48Z/);
    assert.match(agentEngineExpiryWarning("memory", "soon", exp)!, /isn't a date/);
    assert.equal(agentEngineExpiryWarning("memory", undefined, exp), undefined);
    const c = loadConfig({ AGENT_ENGINE_MEMORY_PROJECT_ID: "p", AGENT_ENGINE_MEMORY_SA: SA, AGENT_ENGINE_MEMORY_SA_EXPIRES_AT: at });
    assert.equal(agentEngineWarnings(c, {}, exp - 3 * day).length, 1);
  });

  test("the client logs the rotation warning on a token refresh, at most once a day", async () => {
    const day = 24 * 60 * 60_000;
    const c = clock(Date.parse("2026-12-25T00:00:00Z"));
    const fake = new FakeAgentEngine({ now: c.now, tokenLifetimeSec: 3600 });
    const logs: string[] = [];
    const client = new AgentEngineClient({ part: "memory", baseUrl: fake.baseUrl, project: { ...FAKE_PROJECTS.memory, expiresAt: "2026-12-30T01:51:48Z" }, fetch: fake.fetch, now: c.now, log: (m) => logs.push(m) });
    await client.token();
    c.advance(3600_000);
    await client.token();
    assert.equal(logs.length, 1);
    c.advance(day);
    await client.token();
    assert.equal(logs.length, 2);
    assert.doesNotMatch(logs.join("\n"), /ae_sa_sk/);
  });
});
