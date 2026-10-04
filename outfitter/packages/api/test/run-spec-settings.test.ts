// CA-6 (#395, docs/specs/central-auth.md §9): the session owner's resolved settings ride run.spec.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildTestApp, type TestApp } from "./helpers.ts";
import { openAgentSocket, makeRunningSession, sendHello } from "./agent-socket.ts";
import { MemoryStore } from "../src/store/memory.ts";
import { settingsDocId, type SettingsDoc } from "../src/store/settings.ts";
import { defaultFleetSettings } from "../src/fleet-settings.ts";
import { runSettingExcluded, runSpecSettings } from "../src/central/run-keys.ts";
import { userIdFor } from "../src/central/user-id.ts";

const OWNER = "owner@example.com";
const USER = userIdFor(OWNER);
const NOW = "2026-10-04T10:00:00.000Z";
const DSN = "https://k@o0.ingest.sentry.io/1";

function doc(id: string, level: SettingsDoc["level"], values: SettingsDoc["values"], extra: Partial<SettingsDoc> = {}): SettingsDoc {
  return { id, level, userId: USER, values, version: 0, createdAt: NOW, updatedAt: NOW, updatedBy: OWNER, ...extra };
}

async function seedOwner(store: MemoryStore): Promise<void> {
  await store.settings.put(doc(settingsDocId("user", USER), "user", { "model.default": "litellm/user-model", "compaction.summaryModel": "litellm/gpt-5.4-nano" }), 0);
  await store.settings.put(doc(settingsDocId("profile", USER, "work"), "profile", { "model.default": "litellm/work-model" }, { name: "work", isDefault: true }), 0);
  await store.settings.put(doc(settingsDocId("profile", USER, "home"), "profile", { "model.default": "litellm/home-model" }, { name: "home" }), 0);
  // A device level the run must not see.
  await store.settings.put(doc(settingsDocId("device", "dev_abc"), "device", { "model.thinking": "xhigh" }, { deviceId: "dev_abc" }), 0);
}

async function specFor(app: TestApp, ownerEmail?: string): Promise<any> {
  const { session, runId, runToken } = await makeRunningSession(app, ownerEmail ? { ownerEmail } : {});
  const agent = await openAgentSocket(app, runId);
  sendHello(agent, runId, session.id, runToken);
  const spec = await agent.nextMessage();
  agent.send({ t: "bye", reason: "idle" });
  await agent.nextClose();
  return spec;
}

async function close(app: TestApp) {
  app.stopBackgroundTasks();
  await app.fastify.close();
}

describe("runSpecSettings", () => {
  test("the owner's default profile over their account and the fleet, with sources; no rule metadata", async () => {
    const store = new MemoryStore();
    await seedOwner(store);
    const fleet = { ...defaultFleetSettings(), values: { "model.provider": "litellm", "memory.mode": "tool" }, version: 3 };
    const settings = await runSpecSettings(store, fleet, OWNER);
    assert.equal(settings?.schemaVersion, 1);
    assert.equal(settings?.profile, "work");
    assert.deepEqual(settings?.values["model.default"], { value: "litellm/work-model", source: "profile", sourceName: "work" });
    assert.deepEqual(settings?.values["compaction.summaryModel"], { value: "litellm/gpt-5.4-nano", source: "user" });
    assert.deepEqual(settings?.values["memory.mode"], { value: "tool", source: "fleet" });
    assert.deepEqual(settings?.values["compaction.masking"], { value: true, source: "default" });
    assert.equal(settings?.values["model.thinking"], undefined, "no device level");
  });

  test("router and telemetry keys stay out (pinned by the api and spec.telemetry)", async () => {
    const store = new MemoryStore();
    const fleet = { telemetry: { sentry: { enabled: true, dsn: DSN, tracesSampleRate: 0.1 } }, values: { "router.baseUrl": "https://elsewhere.example/v1" } };
    const settings = await runSpecSettings(store, fleet, OWNER);
    assert.ok(settings);
    for (const key of Object.keys(settings.values)) assert.equal(runSettingExcluded(key), false, key);
    assert.equal(settings.values["router.baseUrl"], undefined);
    assert.equal(settings.values["telemetry.sentry.dsn"], undefined);
    assert.equal(settings.values["telemetry.sentry.enabled"], undefined);
    assert.equal(settings.profile, null);
  });

  test("a store failure gives no settings rather than an error", async () => {
    const store = new MemoryStore();
    store.settings.listProfiles = async () => {
      throw new Error("atlas blip");
    };
    const logs: string[] = [];
    assert.equal(await runSpecSettings(store, defaultFleetSettings(), OWNER, { log: (msg) => logs.push(msg) }), undefined);
    assert.equal(logs.length, 1);
  });
});

describe("run.spec.settings over the agent socket", () => {
  test("an owned session's spec carries the owner's settings", async () => {
    const store = new MemoryStore();
    await seedOwner(store);
    const app = await buildTestApp({}, { store });
    try {
      const spec = await specFor(app, OWNER);
      assert.equal(spec.settings.profile, "work");
      assert.equal(spec.settings.values["model.default"].value, "litellm/work-model");
      assert.equal(spec.settings.values["model.default"].source, "profile");
      // The tape's own model is untouched; agentd decides (agentd/src/settings.ts).
      assert.notEqual(spec.guru.model, "litellm/work-model");
    } finally {
      await close(app);
    }
  });

  test("no settings without an owner, and a resolve failure doesn't fail the run", async () => {
    const store = new MemoryStore();
    const app = await buildTestApp({}, { store });
    try {
      const spec = await specFor(app);
      assert.equal(spec.t, "run.spec");
      assert.equal(spec.settings, undefined);
    } finally {
      await close(app);
    }

    const broken = new MemoryStore();
    broken.settings.get = async () => {
      throw new Error("atlas blip");
    };
    const app2 = await buildTestApp({}, { store: broken });
    try {
      const spec = await specFor(app2, OWNER);
      assert.equal(spec.t, "run.spec");
      assert.equal(spec.settings, undefined);
    } finally {
      await close(app2);
    }
  });
});
