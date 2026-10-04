// CA-6 (#395, docs/specs/central-auth.md §9): per-run LiteLLM keys for Drives and the system team.
// LiteLLM is the fake management API (test/fake-litellm.ts) throughout; nothing reaches a router.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, type TestApp } from "./helpers.ts";
import { openAgentSocket, makeRunningSession, sendHello } from "./agent-socket.ts";
import { FakeLitellm } from "./fake-litellm.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { MemorySecretsBroker } from "../src/secrets.ts";
import { createLitellmKeys, routerKeyLimits, runKeyAlias, RUN_KEY_MAX_BUDGET_USD, type LitellmKeys } from "../src/central/litellm-keys.ts";
import { defaultFleetSettings, type FleetSettings } from "../src/fleet-settings.ts";
import { RunKeys, RunKeyUnavailableError, MAX_RUN_KEYS, RUN_KEY_DURATION_SECONDS, SYSTEM_TEAM_ALIAS } from "../src/central/run-keys.ts";
import { userIdFor } from "../src/central/user-id.ts";
import { loadConfig } from "../src/config.ts";
import type { Run } from "../src/store/types.ts";

const CONFIG = { litellmBaseUrl: "https://router.test/v1", litellmAdminKey: "sk-admin-test" };
const OWNER = "owner@example.com";
const SHARED = "sk-shared-default";

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function setup(opts: { fallback?: boolean; minting?: boolean; fleet?: FleetSettings } = {}) {
  const fake = new FakeLitellm();
  const store = new MemoryStore();
  const keys = opts.minting === false ? undefined : createLitellmKeys(CONFIG, store, { fetch: fake.fetch })!;
  const logs: string[] = [];
  const fleet = opts.fleet ?? defaultFleetSettings();
  const runKeys = new RunKeys({ keys, store, config: { runKeyFallback: opts.fallback ?? true }, limits: async () => routerKeyLimits(fleet), log: (msg) => logs.push(msg) });
  return { fake, store, keys, runKeys, logs };
}

function run(state: Run["state"] = "provisioning", id = "r1"): Pick<Run, "id" | "state"> {
  return { id, state };
}

describe("RunKeys.keyForRun", () => {
  test("mints with the fleet's run budget and models (router.runKey.maxBudgetUsd, router.keys.models)", async () => {
    const fleet = { ...defaultFleetSettings(), values: { "router.runKey.maxBudgetUsd": 4, "router.keys.models": "claude-auto-llm" } };
    const { fake, store, runKeys } = setup({ fleet });
    await runKeys.keyForRun({ run: run(), session: { id: "s1", ownerEmail: OWNER }, specSent: "no", sharedKey: SHARED, a2a: false });
    const [gen] = fake.callsTo("/key/generate");
    assert.equal(gen!.body.max_budget, 4);
    assert.deepEqual(gen!.body.models, ["claude-auto-llm"]);
    assert.ok(!("rpm_limit" in gen!.body), "device-only limits stay off run keys");
    const record = await store.routerKeys.findByAlias("outfitter-run-r1");
    assert.equal(record?.maxBudget, 4);
  });

  test("mints a key for the owner: alias, user_id, 24 h duration, run budget, metadata", async () => {
    const { fake, store, runKeys } = setup();
    const choice = await runKeys.keyForRun({ run: run(), session: { id: "s1", ownerEmail: OWNER }, specSent: "no", sharedKey: SHARED, a2a: false });
    assert.equal(choice.source, "run");
    assert.equal(choice.alias, runKeyAlias("r1"));
    assert.match(choice.key, /^sk-fake-/);
    const [gen] = fake.callsTo("/key/generate");
    assert.equal(gen!.body.key_alias, "outfitter-run-r1");
    assert.equal(gen!.body.user_id, userIdFor(OWNER));
    assert.equal(gen!.body.duration, `${RUN_KEY_DURATION_SECONDS}s`);
    assert.equal(RUN_KEY_DURATION_SECONDS, 86_400);
    assert.equal(gen!.body.max_budget, RUN_KEY_MAX_BUDGET_USD);
    assert.deepEqual(gen!.body.metadata, { outfitter: "run", runId: "r1", sessionId: "s1" });
    // The LiteLLM user exists first, keyed by the user id, never the email alone.
    assert.equal(fake.users.get(userIdFor(OWNER))?.user_email, OWNER);
    const record = await store.routerKeys.findByAlias("outfitter-run-r1");
    assert.equal(record?.kind, "run");
    assert.equal(record?.userId, userIdFor(OWNER));
    assert.equal(JSON.stringify(record).includes(choice.key), false, "the key value is never stored");
  });

  test("today's shared key without minting, without an owner, and for an A2A session", async () => {
    const off = setup({ minting: false });
    assert.deepEqual(await off.runKeys.keyForRun({ run: run(), session: { id: "s1", ownerEmail: OWNER }, specSent: "no", sharedKey: SHARED, a2a: false }), { key: SHARED, source: "shared" });
    assert.equal(off.runKeys.enabled, false);

    const { fake, runKeys } = setup();
    assert.deepEqual(await runKeys.keyForRun({ run: run(), session: { id: "s1" }, specSent: "no", sharedKey: SHARED, a2a: false }), { key: SHARED, source: "shared" });
    assert.deepEqual(await runKeys.keyForRun({ run: run(), session: { id: "s1", ownerEmail: OWNER }, specSent: "no", sharedKey: "sk-tape-own", a2a: true }), { key: "sk-tape-own", source: "shared" });
    assert.equal(fake.callsTo("/key/generate").length, 0);
  });

  test("a reconnect of a running run never mints and sends no key", async () => {
    const { fake, runKeys } = setup();
    for (const state of ["running", "idle", "stopping"] as const) {
      const choice = await runKeys.keyForRun({ run: run(state), session: { id: "s1", ownerEmail: OWNER }, specSent: "yes", sharedKey: SHARED, a2a: false });
      assert.deepEqual(choice, { key: "", source: "run", alias: "outfitter-run-r1" });
    }
    assert.equal(fake.calls.length, 0);
  });

  test("a spec built but never sent: its key is replaced", async () => {
    const { fake, store, runKeys } = setup();
    const first = await runKeys.keyForRun({ run: run(), session: { id: "s1", ownerEmail: OWNER }, specSent: "no", sharedKey: SHARED, a2a: false });
    const second = await runKeys.keyForRun({ run: run(), session: { id: "s1", ownerEmail: OWNER }, specSent: "no", sharedKey: SHARED, a2a: false });
    assert.equal(second.source, "run");
    assert.notEqual(second.key, first.key);
    assert.equal(second.alias, "outfitter-run-r1-2", "a new record, never the earlier one overwritten");
    assert.equal(fake.callsTo("/key/delete").length, 1);
    assert.equal(fake.keys.size, 1, "only the new key is live in LiteLLM");
    assert.ok((await store.routerKeys.findByAlias("outfitter-run-r1"))?.deletedAt);
    assert.equal((await store.routerKeys.findByAlias("outfitter-run-r1-2"))?.deletedAt, undefined);
  });

  test("a spec never sent whose earlier key can't be deleted: that key stays owed to the sweep", async () => {
    const { fake, store, runKeys } = setup();
    await runKeys.keyForRun({ run: run(), session: { id: "s1", ownerEmail: OWNER }, specSent: "no", sharedKey: SHARED, a2a: false });
    const before = await store.routerKeys.findByAlias("outfitter-run-r1");
    assert.ok(before?.litellmTokenId);
    fake.failNext("/key/delete", 500);
    const second = await runKeys.keyForRun({ run: run(), session: { id: "s1", ownerEmail: OWNER }, specSent: "no", sharedKey: SHARED, a2a: false });
    assert.equal(second.alias, "outfitter-run-r1-2");
    const owed = await store.routerKeys.findByAlias("outfitter-run-r1");
    assert.equal(owed?.litellmTokenId, before.litellmTokenId, "the record of the undeleted key is intact");
    assert.ok(owed?.deleteFailedAt);
    assert.equal(owed?.deletedAt, undefined);
    assert.deepEqual((await store.routerKeys.listPendingDelete(10)).map((k) => k.alias), ["outfitter-run-r1"]);
  });

  test("a spec that may have gone out keeps its key; a fresh agentd gets the shared key while the fallback lasts", async () => {
    const { fake, runKeys } = setup();
    const first = await runKeys.keyForRun({ run: run(), session: { id: "s1", ownerEmail: OWNER }, specSent: "no", sharedKey: SHARED, a2a: false });
    for (const specSent of ["yes", "unknown"] as const) {
      const again = await runKeys.keyForRun({ run: run(), session: { id: "s1", ownerEmail: OWNER }, specSent, sharedKey: SHARED, a2a: false });
      assert.deepEqual(again, { key: SHARED, source: "shared" });
    }
    assert.equal(fake.callsTo("/key/delete").length, 0);
    assert.ok([...fake.keys.values()].some((k) => k.key === first.key), "the first key stays live");
  });

  test("without the fallback, a spec that may have gone out keeps its key and a re-sent one gets an additional key", async () => {
    const { fake, store, runKeys } = setup({ fallback: false });
    const first = await runKeys.keyForRun({ run: run(), session: { id: "s1", ownerEmail: OWNER }, specSent: "no", sharedKey: SHARED, a2a: false });
    const again = await runKeys.keyForRun({ run: run(), session: { id: "s1", ownerEmail: OWNER }, specSent: "yes", sharedKey: SHARED, a2a: false });
    const third = await runKeys.keyForRun({ run: run(), session: { id: "s1", ownerEmail: OWNER }, specSent: "unknown", sharedKey: SHARED, a2a: false });
    assert.deepEqual([again.source, again.alias, third.alias], ["run", "outfitter-run-r1-2", "outfitter-run-r1-3"]);
    assert.equal(fake.callsTo("/key/delete").length, 0);
    assert.ok([...fake.keys.values()].some((k) => k.key === first.key), "the first key survives the re-sent spec");
    assert.equal(fake.keys.size, 3);
    assert.equal((await store.routerKeys.findByAlias("outfitter-run-r1"))?.deletedAt, undefined);

    // At bye every one of them goes.
    await runKeys.revoke("r1");
    assert.equal(fake.keys.size, 0);
    for (const alias of ["outfitter-run-r1", "outfitter-run-r1-2", "outfitter-run-r1-3"]) {
      assert.ok((await store.routerKeys.findByAlias(alias))?.deletedAt, alias);
    }
  });

  test("a run past MAX_RUN_KEYS counts as a failed mint", async () => {
    const { fake, runKeys } = setup({ fallback: false });
    const req = { run: run(), session: { id: "s1", ownerEmail: OWNER }, specSent: "yes" as const, sharedKey: SHARED, a2a: false };
    for (let i = 0; i < MAX_RUN_KEYS; i++) await runKeys.keyForRun(req);
    await assert.rejects(runKeys.keyForRun(req), RunKeyUnavailableError);
    assert.equal(fake.callsTo("/key/generate").length, MAX_RUN_KEYS);
  });

  test("a failed mint falls back to the shared key, or refuses (retryable) with the fallback off", async () => {
    const on = setup();
    on.fake.failNext("/key/generate", 500, { error: { message: "db down sk-leaky-1234" } });
    assert.deepEqual(await on.runKeys.keyForRun({ run: run(), session: { id: "s1", ownerEmail: OWNER }, specSent: "no", sharedKey: SHARED, a2a: false }), { key: SHARED, source: "shared" });
    assert.ok(on.logs.some((l) => l.includes("using the shared key")));

    const off = setup({ fallback: false });
    off.fake.down = true;
    await assert.rejects(
      off.runKeys.keyForRun({ run: run(), session: { id: "s1", ownerEmail: OWNER }, specSent: "no", sharedKey: SHARED, a2a: false }),
      (err: unknown) => err instanceof RunKeyUnavailableError && !String((err as Error).message).includes(SHARED),
    );
  });
});

describe("RunKeys.revoke and the system team", () => {
  test("revoke deletes the run's key once, and does nothing for a run that had none", async () => {
    const { fake, store, runKeys } = setup();
    await runKeys.keyForRun({ run: run(), session: { id: "s1", ownerEmail: OWNER }, specSent: "no", sharedKey: SHARED, a2a: false });
    await runKeys.revoke("r1");
    assert.equal(fake.keys.size, 0);
    assert.ok((await store.routerKeys.findByAlias("outfitter-run-r1"))?.deletedAt);
    await runKeys.revoke("r1");
    await runKeys.revoke("never-had-one");
    assert.equal(fake.callsTo("/key/delete").length, 1);
  });

  test("a failed revoke never throws and is owed to the sweep", async () => {
    const { fake, store, runKeys } = setup();
    await runKeys.keyForRun({ run: run(), session: { id: "s1", ownerEmail: OWNER }, specSent: "no", sharedKey: SHARED, a2a: false });
    fake.failNext("/key/delete", 500);
    await runKeys.revoke("r1");
    assert.ok((await store.routerKeys.findByAlias("outfitter-run-r1"))?.deleteFailedAt);
    assert.deepEqual((await store.routerKeys.listPendingDelete(10)).map((k) => k.alias), ["outfitter-run-r1"]);
  });

  test("ensureSystemTeam creates outfitter-system once; undefined without minting or on failure", async () => {
    const { fake, runKeys } = setup();
    const id = await runKeys.ensureSystemTeam();
    assert.equal(typeof id, "string");
    assert.equal(await runKeys.ensureSystemTeam(), id);
    assert.deepEqual(fake.teams.map((t) => t.team_alias), [SYSTEM_TEAM_ALIAS]);
    assert.equal(fake.callsTo("/team/new").length, 1);

    assert.equal(await setup({ minting: false }).runKeys.ensureSystemTeam(), undefined);
    const failing = setup();
    failing.fake.failNext("/team/list", 403);
    assert.equal(await failing.runKeys.ensureSystemTeam(), undefined);
  });

  test("OUTFITTER_RUN_KEY_FALLBACK: on unless 0", () => {
    const base = { OUTFITTER_DEV: "1", MONGODB_URI: "memory" } as NodeJS.ProcessEnv;
    assert.equal(loadConfig(base).runKeyFallback, true);
    assert.equal(loadConfig({ ...base, OUTFITTER_RUN_KEY_FALLBACK: "1" }).runKeyFallback, true);
    assert.equal(loadConfig({ ...base, OUTFITTER_RUN_KEY_FALLBACK: "0" }).runKeyFallback, false);
  });
});

describe("run.spec over the agent socket", () => {
  async function app(opts: { keys?: (store: MemoryStore, fake: FakeLitellm) => LitellmKeys | undefined; env?: Record<string, string> } = {}) {
    const fake = new FakeLitellm();
    const store = new MemoryStore();
    const keys = opts.keys ? opts.keys(store, fake) : createLitellmKeys(CONFIG, store, { fetch: fake.fetch });
    const built = await buildTestApp(opts.env ?? {}, { store, litellmKeys: keys, secretsBroker: new MemorySecretsBroker("", SHARED) });
    return { app: built, fake, store };
  }

  async function close(app: TestApp) {
    app.stopBackgroundTasks();
    await app.fastify.close();
  }

  test("the owner's run gets its own key, deleted at bye; the system team exists after start-up", async () => {
    const { app: a, fake, store } = await app();
    try {
      await waitFor(() => fake.teams.some((t) => t.team_alias === SYSTEM_TEAM_ALIAS));
      const { session, runId, runToken } = await makeRunningSession(a, { ownerEmail: OWNER });
      const agent = await openAgentSocket(a, runId);
      sendHello(agent, runId, session.id, runToken);
      const spec = await agent.nextMessage();
      assert.equal(spec.t, "run.spec");
      assert.match(spec.secrets.litellmKey, /^sk-fake-/);
      assert.notEqual(spec.secrets.litellmKey, SHARED);
      const [gen] = fake.callsTo("/key/generate");
      assert.equal(gen!.body.key_alias, `outfitter-run-${runId}`);
      assert.equal(gen!.body.user_id, userIdFor(OWNER));

      agent.send({ t: "bye", reason: "idle" });
      assert.equal((await agent.nextClose()).code, 1000);
      await waitFor(async () => Boolean((await store.routerKeys.findByAlias(`outfitter-run-${runId}`))?.deletedAt));
      assert.equal(fake.keys.size, 0);
    } finally {
      await close(a);
    }
  });

  test("a session without an owner, and an app without minting, keep the shared key", async () => {
    const { app: a, fake } = await app();
    try {
      const { session, runId, runToken } = await makeRunningSession(a);
      const agent = await openAgentSocket(a, runId);
      sendHello(agent, runId, session.id, runToken);
      const spec = await agent.nextMessage();
      assert.equal(spec.secrets.litellmKey, SHARED);
      assert.equal(fake.callsTo("/key/generate").length, 0);
      agent.send({ t: "bye", reason: "idle" });
      await agent.nextClose();
    } finally {
      await close(a);
    }

    const { app: b } = await app({ keys: () => undefined });
    try {
      const { session, runId, runToken } = await makeRunningSession(b, { ownerEmail: OWNER });
      const agent = await openAgentSocket(b, runId);
      sendHello(agent, runId, session.id, runToken);
      assert.equal((await agent.nextMessage()).secrets.litellmKey, SHARED);
      agent.send({ t: "bye", reason: "idle" });
      await agent.nextClose();
    } finally {
      await close(b);
    }
  });

  test("a reconnect of a running run mints nothing and carries no key", async () => {
    const { app: a, fake } = await app();
    try {
      const { session, runId, runToken } = await makeRunningSession(a, { ownerEmail: OWNER });
      const first = await openAgentSocket(a, runId);
      sendHello(first, runId, session.id, runToken);
      const spec = await first.nextMessage();
      assert.match(spec.secrets.litellmKey, /^sk-fake-/);
      first.send({ t: "status", state: "idle" });
      await waitFor(async () => (await a.store.runs.findById(runId))?.state === "idle");
      first.close();
      await new Promise((r) => setTimeout(r, 50));

      const second = await openAgentSocket(a, runId);
      sendHello(second, runId, session.id, runToken, 0);
      const again = await second.nextMessage();
      assert.equal(again.t, "run.spec");
      assert.equal(again.secrets.litellmKey, "");
      assert.equal(fake.callsTo("/key/generate").length, 1);
      second.send({ t: "bye", reason: "idle" });
      await second.nextClose();
    } finally {
      await close(a);
    }
  });

  test("with the fallback off, a failed mint is a retryable spec failure with a run note", async () => {
    const { app: a, fake } = await app({ env: { OUTFITTER_RUN_KEY_FALLBACK: "0" } });
    try {
      fake.down = true;
      const { session, runId, runToken } = await makeRunningSession(a, { ownerEmail: OWNER });
      const agent = await openAgentSocket(a, runId);
      sendHello(agent, runId, session.id, runToken);
      const closed = await agent.nextClose();
      assert.equal(closed.code, 1011);
      const stored = await a.store.runs.findById(runId);
      assert.match(stored?.statusDetail ?? "", /could not mint this run's LiteLLM key/);
      assert.notEqual(stored?.state, "failed");
    } finally {
      await close(a);
    }
  });
});
