// Central settings, CA-3 (#392, docs/specs/central-auth.md §3): the schema's write validation, the
// memory settings collection's versioned writes, and resolveConfig's override rules and sources.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store/memory.ts";
import { MemorySettings, settingsDocId, type SettingsDoc } from "../src/store/settings.ts";
import { defaultFleetSettings, withDefaults, type FleetSettings } from "../src/fleet-settings.ts";
import { resolveConfig, resolveKey, UnknownProfileError, fleetLevelValues } from "../src/central/settings-resolver.ts";
import { coerceSettingValue, parseValueWrite, applyValuePatch, publicSchema, settingDecl, SETTINGS_SCHEMA_VERSION } from "../src/central/settings-schema.ts";
import { userIdFor } from "../src/central/user-id.ts";

const EMAIL = "a@example.com";
const USER = userIdFor(EMAIL);
const DSN = "https://k@o0.ingest.sentry.io/1";
const NOW = "2026-10-04T10:00:00.000Z";

function doc(id: string, level: SettingsDoc["level"], values: SettingsDoc["values"], extra: Partial<SettingsDoc> = {}): SettingsDoc {
  return { id, level, userId: USER, values, version: 0, createdAt: NOW, updatedAt: NOW, updatedBy: EMAIL, ...extra };
}

async function seed(store: MemoryStore, ...docs: SettingsDoc[]): Promise<void> {
  for (const d of docs) assert.equal((await store.settings.put(d, 0)).ok, true);
}

describe("schema validation", () => {
  test("coerces each type and refuses misfits", () => {
    const decl = (k: string) => settingDecl(k)!;
    assert.equal(coerceSettingValue(decl("model.default"), "  claude-auto-llm "), "claude-auto-llm");
    assert.equal(coerceSettingValue(decl("model.default"), "   "), undefined);
    assert.equal(coerceSettingValue(decl("model.default"), "a\nb"), undefined);
    assert.equal(coerceSettingValue(decl("model.default"), 3), undefined);
    assert.equal(coerceSettingValue(decl("model.provider"), "lmstudio"), "lmstudio");
    assert.equal(coerceSettingValue(decl("model.provider"), "ollama"), undefined);
    assert.equal(coerceSettingValue(decl("voice.enabled"), "true"), undefined);
    assert.equal(coerceSettingValue(decl("voice.enabled"), true), true);
    assert.equal(coerceSettingValue(decl("telemetry.sentry.tracesSampleRate"), 0.5), 0.5);
    assert.equal(coerceSettingValue(decl("telemetry.sentry.tracesSampleRate"), 1.5), undefined);
    assert.equal(coerceSettingValue(decl("telemetry.sentry.tracesSampleRate"), Number.NaN), undefined);
    assert.equal(coerceSettingValue(decl("router.baseUrl"), "https://r.example/v1"), "https://r.example/v1");
    assert.equal(coerceSettingValue(decl("router.baseUrl"), "ftp://r.example"), undefined);
    assert.equal(coerceSettingValue(decl("router.baseUrl"), "not a url"), undefined);
    assert.equal(coerceSettingValue(decl("router.baseUrl"), "http://r.example/v1"), undefined, "https only by default");
    assert.equal(coerceSettingValue(decl("router.baseUrl"), "http://r.example/v1", { allowHttp: true }), "http://r.example/v1", "http in dev mode");
  });

  test("the curated OpenRouter list (#440): each key is written at its own level only", () => {
    const ids = "deepseek/deepseek-v4-pro,openai/gpt-5.5";
    for (const key of ["openrouter.models.fleetAdd", "openrouter.models.fleetRemove"]) {
      assert.deepEqual(parseValueWrite("fleet", { values: { [key]: ids } }), { patch: { [key]: ids } });
      assert.deepEqual(parseValueWrite("user", { values: { [key]: ids } }), { error: "level_not_allowed", key });
    }
    for (const key of ["openrouter.models.add", "openrouter.models.remove"]) {
      for (const level of ["user", "profile"] as const) assert.deepEqual(parseValueWrite(level, { values: { [key]: ids } }), { patch: { [key]: ids } });
      assert.deepEqual(parseValueWrite("fleet", { values: { [key]: ids } }), { error: "level_not_allowed", key });
    }
    // this machine's own keys are declared for Kernal but never stored by Outfitter
    for (const key of ["openrouter.models.localAdd", "openrouter.models.localRemove"]) {
      assert.deepEqual(parseValueWrite("user", { values: { [key]: ids } }), { error: "level_not_allowed", key });
    }
    assert.equal(SETTINGS_SCHEMA_VERSION, 3);
  });

  test("parseValueWrite checks declared, secret, level and type, in that order", () => {
    assert.deepEqual(parseValueWrite("user", { values: { "model.default": "m", "voice.enabled": null } }), { patch: { "model.default": "m", "voice.enabled": null } });
    assert.deepEqual(parseValueWrite("user", {}), { error: "invalid_request" });
    assert.deepEqual(parseValueWrite("user", { values: [] }), { error: "invalid_request" });
    assert.deepEqual(parseValueWrite("user", { values: { "no.such": 1 } }), { error: "unknown_key", key: "no.such" });
    assert.deepEqual(parseValueWrite("device", { values: { "router.key": "sk-1" } }), { error: "unknown_key", key: "router.key" }, "secrets are never written here");
    assert.deepEqual(parseValueWrite("user", { values: { "router.baseUrl": "https://x" } }), { error: "level_not_allowed", key: "router.baseUrl" });
    assert.deepEqual(parseValueWrite("profile", { values: { "telemetry.sentry.enabled": null } }), { error: "level_not_allowed", key: "telemetry.sentry.enabled" });
    assert.deepEqual(parseValueWrite("user", { values: { "model.thinking": "max" } }), { error: "invalid_value", key: "model.thinking" });
  });

  test("applyValuePatch merges and removes", () => {
    assert.deepEqual(applyValuePatch({ a: 1, b: "x" }, { a: null, c: true }), { b: "x", c: true });
  });

  test("the public schema has every non-retired key and the version", () => {
    const schema = publicSchema();
    assert.equal(schema.schemaVersion, SETTINGS_SCHEMA_VERSION);
    assert.ok(schema.settings.some((d) => d.key === "router.key"), "secrets are declared, so /config can show their source");
    assert.ok(schema.settings.every((d) => !d.retired));
  });
});

describe("MemorySettings", () => {
  test("put is versioned: 0 creates once, a stale version returns the current document", async () => {
    const s = new MemorySettings();
    const d = doc("user:u", "user", { "model.default": "a" });
    const first = await s.put(d, 0);
    assert.ok(first.ok && first.doc.version === 1);
    const again = await s.put(d, 0);
    assert.ok(!again.ok && again.current?.version === 1);
    const second = await s.put({ ...d, values: { "model.default": "b" } }, 1);
    assert.ok(second.ok && second.doc.version === 2);
    const stale = await s.put(d, 1);
    assert.ok(!stale.ok && stale.current?.values["model.default"] === "b");
    assert.equal((await s.get("user:u"))?.values["model.default"], "b");
  });

  test("delete only at the expected version; null current when missing", async () => {
    const s = new MemorySettings();
    await s.put(doc("profile:u:work", "profile", {}, { name: "work" }), 0);
    const wrong = await s.delete("profile:u:work", 7);
    assert.ok(!wrong.ok && wrong.current?.version === 1);
    assert.deepEqual(await s.delete("profile:u:work", 1), { ok: true, doc: null });
    assert.deepEqual(await s.delete("profile:u:work", 1), { ok: false, current: null });
  });

  test("setDefaultProfile leaves one default and bumps every document it changes", async () => {
    const s = new MemorySettings();
    await s.put(doc("profile:u:a", "profile", {}, { userId: "u", name: "a", isDefault: true }), 0);
    await s.put(doc("profile:u:b", "profile", {}, { userId: "u", name: "b" }), 0);
    await s.put(doc("profile:v:c", "profile", {}, { userId: "v", name: "c", isDefault: true }), 0);
    await s.setDefaultProfile("u", "b");
    const [a, b] = await s.listProfiles("u");
    assert.equal(a!.isDefault, undefined);
    assert.equal(a!.version, 2);
    assert.equal(b!.isDefault, true);
    assert.equal(b!.version, 2);
    assert.equal((await s.get("profile:v:c"))!.isDefault, true, "another user's default is untouched");
    await s.setDefaultProfile("u", "b");
    assert.equal((await s.get("profile:u:b"))!.version, 2, "no change, no bump");
  });
});

describe("resolveKey rules", () => {
  const levels = (...pairs: Array<[string, Record<string, string | number | boolean>, string?]>) =>
    pairs.map(([source, values, sourceName]) => ({ source: source as "fleet", values, ...(sourceName ? { sourceName } : {}) }));

  test("any: the lowest level wins, not locked", () => {
    const r = resolveKey(settingDecl("model.default")!, levels(["fleet", { "model.default": "f" }], ["user", { "model.default": "u" }], ["profile", { "model.default": "p" }, "work"]));
    assert.deepEqual(r, { value: "p", source: "profile", sourceName: "work", override: "any", locked: false, localAllowed: true });
  });

  test("none: the highest level wins, locked from fleet", () => {
    const r = resolveKey(settingDecl("router.baseUrl")!, levels(["fleet", { "router.baseUrl": "https://f/v1" }]));
    assert.equal(r?.value, "https://f/v1");
    assert.equal(r?.locked, true);
    const d = resolveKey(settingDecl("router.baseUrl")!, []);
    assert.deepEqual(d, { value: "https://router.kernal.one/v1", source: "default", override: "none", locked: false, localAllowed: true });
  });

  test("opt-out: false anywhere wins and locks; true only from above", () => {
    const decl = { ...settingDecl("voice.enabled")!, override: "opt-out" as const, levels: ["fleet", "user", "device", "local"] as const };
    assert.deepEqual(resolveKey(decl, levels(["fleet", { "voice.enabled": true }], ["user", { "voice.enabled": true }])), { value: true, source: "fleet", override: "opt-out", locked: false, localAllowed: true });
    const off = resolveKey(decl, levels(["fleet", { "voice.enabled": true }], ["device", { "voice.enabled": false }]));
    assert.equal(off?.value, false);
    assert.equal(off?.source, "device");
    assert.equal(off?.locked, true);
  });

  test("a level the key doesn't allow, or a value that no longer fits, is skipped", () => {
    const r = resolveKey(settingDecl("localHost.shareModels")!, levels(["fleet", { "localHost.shareModels": true }], ["user", { "localHost.shareModels": "yes" }]));
    assert.equal(r?.source, "default");
    assert.equal(r?.value, false);
  });
});

describe("resolveConfig", () => {
  test("fleet → user → profile → device, each value with its source and versions", async () => {
    const store = new MemoryStore();
    await seed(
      store,
      doc(settingsDocId("user", USER), "user", { "model.default": "user-model", "voice.language": "de" }),
      doc(settingsDocId("profile", USER, "work"), "profile", { "model.default": "work-model" }, { name: "work", isDefault: true }),
      doc(settingsDocId("profile", USER, "personal"), "profile", { "model.default": "home-model" }, { name: "personal" }),
      doc(settingsDocId("device", "dev_1"), "device", { "voice.language": "fr" }, { deviceId: "dev_1" }),
    );
    const fleet: FleetSettings = { ...defaultFleetSettings(), values: { "model.thinking": "low", "router.baseUrl": "https://f/v1" }, version: 3 };
    const res = await resolveConfig(store, fleet, { email: EMAIL, deviceId: "dev_1" }, () => new Date(NOW));
    assert.equal(res.profile, "work", "the default profile");
    assert.deepEqual(res.profiles, ["personal", "work"]);
    assert.equal(res.values["model.default"]?.value, "work-model");
    assert.equal(res.values["model.default"]?.sourceName, "work");
    assert.equal(res.values["voice.language"]?.source, "device");
    assert.equal(res.values["model.thinking"]?.source, "fleet");
    assert.equal(res.values["router.baseUrl"]?.locked, true);
    assert.equal(res.values["router.key"], undefined, "secrets never");
    assert.equal(res.values["memory.mode"], undefined, "no level and no default: absent");
    assert.deepEqual(res.versions, { fleet: 3, user: 1, profile: 1, device: 1 });
    assert.equal(res.resolvedAt, NOW);

    const personal = await resolveConfig(store, fleet, { email: EMAIL, profile: "personal" });
    assert.equal(personal.values["model.default"]?.value, "home-model");
    assert.equal(personal.values["voice.language"]?.source, "user", "no device asked for");
    assert.equal(personal.deviceId, null);
    assert.equal(personal.versions.device, undefined);
  });

  test("a stored document without a values object sets nothing instead of failing", async () => {
    const store = new MemoryStore();
    const broken = (d: SettingsDoc, values: unknown) => ({ ...d, values }) as unknown as SettingsDoc;
    await seed(
      store,
      broken(doc(settingsDocId("group", "everyone"), "group", {}), undefined),
      broken(doc(settingsDocId("user", USER), "user", {}), "junk"),
      broken(doc(settingsDocId("profile", USER, "work"), "profile", {}, { name: "work", isDefault: true }), null),
      broken(doc(settingsDocId("device", "dev_1"), "device", {}, { deviceId: "dev_1" }), ["x"]),
    );
    const fleet = { ...defaultFleetSettings(), values: "junk" } as unknown as FleetSettings;
    const res = await resolveConfig(store, fleet, { email: EMAIL, deviceId: "dev_1" });
    assert.equal(res.profile, "work");
    assert.equal(res.values["model.default"], undefined, "nothing sets it and it has no default");
    assert.equal(res.values["router.baseUrl"]?.source, "default");
  });

  test("stored http URLs resolve only in dev mode", async () => {
    const store = new MemoryStore();
    const fleet: FleetSettings = { ...defaultFleetSettings(), values: { "router.baseUrl": "http://f/v1" } };
    const prod = await resolveConfig(store, fleet, { email: EMAIL });
    assert.equal(prod.values["router.baseUrl"]?.source, "default");
    const dev = await resolveConfig(store, fleet, { email: EMAIL, allowHttp: true });
    assert.equal(dev.values["router.baseUrl"]?.value, "http://f/v1");
  });

  test("no profiles: the profile level is skipped; an unknown profile throws with the list", async () => {
    const store = new MemoryStore();
    const res = await resolveConfig(store, defaultFleetSettings(), { email: EMAIL });
    assert.equal(res.profile, null);
    assert.deepEqual(res.versions, { fleet: 0, user: 0 });
    await seed(store, doc(settingsDocId("profile", USER, "work"), "profile", {}, { name: "work" }));
    const noDefault = await resolveConfig(store, defaultFleetSettings(), { email: EMAIL });
    assert.equal(noDefault.profile, null, "a profile that isn't the default is not applied");
    await assert.rejects(resolveConfig(store, defaultFleetSettings(), { email: EMAIL, profile: "nope" }), (err: unknown) => err instanceof UnknownProfileError && err.profiles.join() === "work");
  });

  test("Sentry: off reads as the default false (locked) with no DSN; on reads from telemetry.sentry", async () => {
    const store = new MemoryStore();
    const off = await resolveConfig(store, defaultFleetSettings(), { email: EMAIL });
    assert.deepEqual(off.values["telemetry.sentry.enabled"], { value: false, source: "default", override: "opt-out", locked: true, localAllowed: true });
    assert.equal(off.values["telemetry.sentry.dsn"], undefined, "the stored DSN is never sent while off");
    assert.equal(off.values["telemetry.sentry.tracesSampleRate"]?.source, "default");

    const on = withDefaults({ telemetry: { sentry: { enabled: true, dsn: DSN, tracesSampleRate: 0.2 } }, values: { "telemetry.sentry.enabled": false } });
    assert.deepEqual(fleetLevelValues(on), { "telemetry.sentry.enabled": true, "telemetry.sentry.dsn": DSN, "telemetry.sentry.tracesSampleRate": 0.2 }, "values never shadow telemetry.sentry");
    const res = await resolveConfig(store, on, { email: EMAIL });
    assert.deepEqual(res.values["telemetry.sentry.enabled"], { value: true, source: "fleet", override: "opt-out", locked: false, localAllowed: true });
    assert.equal(res.values["telemetry.sentry.dsn"]?.value, DSN);
    assert.equal(res.values["telemetry.sentry.dsn"]?.locked, true);
    assert.equal(res.values["telemetry.sentry.tracesSampleRate"]?.value, 0.2);
  });

  test("group is reserved: a group:everyone document is read, but no v1 key allows the level", async () => {
    const store = new MemoryStore();
    await seed(store, { ...doc("group:everyone", "group", { "model.thinking": "high" }), userId: undefined });
    const res = await resolveConfig(store, defaultFleetSettings(), { email: EMAIL });
    assert.equal(res.values["model.thinking"], undefined);
    const decl = { ...settingDecl("model.thinking")!, levels: ["fleet", "group", "user"] as const };
    const r = resolveKey(decl, [
      { source: "fleet", values: { "model.thinking": "low" } },
      { source: "group", sourceName: "everyone", values: { "model.thinking": "high" } },
    ]);
    assert.deepEqual(r, { value: "high", source: "group", sourceName: "everyone", override: "any", locked: false, localAllowed: false });
  });
});

describe("fleet document", () => {
  test("withDefaults keeps values and version, drops junk and Sentry keys from values", () => {
    const d = withDefaults({ telemetry: { sentry: { enabled: false, tracesSampleRate: 0.05 } }, values: { "model.default": "m", "telemetry.sentry.dsn": DSN, bad: { x: 1 } as never }, version: 4 });
    assert.deepEqual(d.values, { "model.default": "m" });
    assert.equal(d.version, 4);
    assert.equal(withDefaults({ version: -1 }).version, undefined);
    assert.deepEqual(withDefaults(null), defaultFleetSettings(), "no document: unchanged");
  });
});
