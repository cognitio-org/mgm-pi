import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedVoiceDefaults, reconcileVoice, languageFromLocale, audioToolHint, DEFAULT_VOICE_MODEL } from "../.pi/extensions/kernal-voice/lib.ts";
import { makePi, makeCtx } from "./harness.ts";

describe("voice defaults", () => {
  test("seeds a local backend when nothing is configured", () => {
    const r = seedVoiceDefaults({ other: 1 }, { language: "sl" });
    assert.equal(r.changed, true);
    assert.deepEqual(r.settings.voice, { version: 2, enabled: true, backend: "local", localModel: DEFAULT_VOICE_MODEL, language: "sl" });
    assert.equal(r.settings.other, 1, "other settings untouched");
  });
  test("never overrides a user's choice", () => {
    assert.equal(seedVoiceDefaults({ voice: { backend: "deepgram" } }).changed, false);
    assert.equal(seedVoiceDefaults({ voice: { deepgramApiKey: "k" } }).changed, false);
    assert.equal(seedVoiceDefaults({}, { deepgramKeyInEnv: true }).changed, false);
    assert.equal(seedVoiceDefaults({ voice: { enabled: false } }).changed, false);
    assert.equal(seedVoiceDefaults({ voice: { backend: "local", localModel: "moonshine-base" } }).changed, false);
    // #249: Deepgram set up with the key only in the shell: stored as no backend, onboarding done.
    assert.equal(seedVoiceDefaults({ voice: { onboarding: { completed: true } } }).changed, false);
  });
  test("keeps existing voice fields and honours a model override", () => {
    const r = seedVoiceDefaults({ voice: { language: "de", holdThresholdMs: 500 } }, { model: "moonshine-base", language: "en" });
    assert.equal(r.settings.voice.language, "de", "existing language wins");
    assert.equal(r.settings.voice.holdThresholdMs, 500);
    assert.equal(r.settings.voice.localModel, "moonshine-base");
  });
  test("language from locale; audio tool hint per platform", () => {
    assert.equal(languageFromLocale("en_US.UTF-8"), "en");
    assert.equal(languageFromLocale("sl_SI"), "sl");
    assert.equal(languageFromLocale(undefined), "en");
    assert.equal(languageFromLocale("C"), "en");
    assert.match(audioToolHint(undefined, "darwin")!, /brew install sox/);
    assert.match(audioToolHint(undefined, "darwin")!, /hold Space/, "#248: Space is hold-to-talk; ctrl+shift+v is a toggle");
    assert.doesNotMatch(audioToolHint(undefined, "darwin")!, /ctrl\+shift\+v/i);
    assert.match(audioToolHint(undefined, "linux")!, /apt install sox/);
    assert.equal(audioToolHint("rec", "darwin"), undefined);
  });
});

describe("reconcileVoice (#249)", () => {
  const AT = "2026-09-28T00:00:00Z";
  const seededVoice = { enabled: true, backend: "local", localModel: DEFAULT_VOICE_MODEL, language: "en", onboarding: { completed: true, source: "migration" } };
  const seededMarker = { state: "seeded" as const, localModel: DEFAULT_VOICE_MODEL, at: AT };
  const base = { deepgramKey: false, modelDownloaded: false, now: AT };

  test("no marker, nothing set up: seeds and marks it", () => {
    const r = reconcileVoice({}, { ...base, language: "sl" });
    assert.equal(r.notice, "seeded");
    assert.equal(r.settings.voice.backend, "local");
    assert.deepEqual(r.marker, { state: "seeded", localModel: DEFAULT_VOICE_MODEL, at: AT });
  });
  test("seeded, then a key: the seed comes out and the marker remembers", () => {
    const r = reconcileVoice({ voice: seededVoice }, { ...base, marker: seededMarker, deepgramKey: true, modelDownloaded: true });
    assert.equal(r.notice, "unseeded");
    assert.deepEqual(r.settings.voice, { enabled: true, language: "en", onboarding: { completed: true, source: "migration" } });
    assert.deepEqual(r.marker, { state: "unseeded", at: AT });
  });
  test("seeded, no key yet: stays, marker kept", () => {
    const r = reconcileVoice({ voice: seededVoice }, { ...base, marker: seededMarker });
    assert.equal(r.changed, false);
    assert.deepEqual(r.marker, seededMarker);
  });
  test("unseeded, then the key goes away: the seed goes back", () => {
    const v = { enabled: true, language: "en", onboarding: { completed: true } };
    const r = reconcileVoice({ voice: v }, { ...base, marker: { state: "unseeded", at: AT } });
    assert.equal(r.notice, "reseeded");
    assert.equal(r.settings.voice.backend, "local");
    assert.equal(r.settings.voice.localModel, DEFAULT_VOICE_MODEL);
    assert.equal(r.marker?.state, "seeded");
  });
  test("unseeded and the key still there: nothing to do", () => {
    const r = reconcileVoice({ voice: { onboarding: { completed: true } } }, { ...base, marker: { state: "unseeded", at: AT }, deepgramKey: true });
    assert.equal(r.changed, false);
    assert.equal(r.marker?.state, "unseeded");
  });
  test("the person changed voice: theirs, and the marker goes (with or without a key)", () => {
    for (const deepgramKey of [false, true]) {
      const other = reconcileVoice({ voice: { ...seededVoice, localModel: "whisper-turbo" } }, { ...base, marker: seededMarker, deepgramKey });
      assert.deepEqual([other.changed, other.marker], [false, undefined]);
    }
    const picked = reconcileVoice({ voice: { backend: "local", localModel: "moonshine-base" } }, { ...base, marker: { state: "unseeded", at: AT } });
    assert.deepEqual([picked.changed, picked.marker], [false, undefined]);
    const off = reconcileVoice({ voice: { enabled: false } }, { ...base, marker: { state: "unseeded", at: AT } });
    assert.deepEqual([off.changed, off.marker], [false, undefined]);
  });
  test("no marker: an earlier seed counts as kernal's only if pi-listen auto-completed it and the model was never downloaded", () => {
    assert.equal(reconcileVoice({ voice: seededVoice }, { ...base, deepgramKey: true }).notice, "unseeded");
    assert.equal(reconcileVoice({ voice: seededVoice }, { ...base, deepgramKey: true, modelDownloaded: true }).changed, false);
    const explicit = { ...seededVoice, onboarding: { completed: true, source: "setup-command" } };
    assert.equal(reconcileVoice({ voice: explicit }, { ...base, deepgramKey: true }).changed, false);
    assert.equal(reconcileVoice({ voice: { ...seededVoice, localModel: "moonshine-base" } }, { ...base, deepgramKey: true }).changed, false);
  });
});

describe("kernal-voice extension", async () => {
  const mod = await import("../.pi/extensions/kernal-voice/index.ts");
  test("seeds pi-listen's global settings file at load time and notifies once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kernal-voice-"));
    process.env.KERNAL_VOICE_SETTINGS = join(dir, "agent", "settings.json");
    delete process.env.DEEPGRAM_API_KEY; delete process.env.KERNAL_VOICE_MODEL;
    const pi = makePi(); mod.default(pi as any);
    assert.ok(existsSync(process.env.KERNAL_VOICE_SETTINGS), "file created, directories too");
    const saved = JSON.parse(readFileSync(process.env.KERNAL_VOICE_SETTINGS, "utf8"));
    assert.equal(saved.voice.backend, "local"); assert.equal(saved.voice.localModel, DEFAULT_VOICE_MODEL);
    const marker = JSON.parse(readFileSync(join(dir, "agent", "kernal-voice-seed.json"), "utf8"));
    assert.equal(marker.state, "seeded", "the seed is marked as kernal's");
    assert.equal(marker.localModel, DEFAULT_VOICE_MODEL);
    assert.deepEqual(readdirSync(join(dir, "agent")).filter((f) => f.endsWith(".tmp")), [], "atomic writes leave no temp file");
    const ctx = makeCtx({}); await pi.emit("session_start", {}, ctx);
    assert.ok(ctx.notices.some((n) => n.msg.includes("Voice input ready")));
    // second load: nothing to seed, no "ready" notice; a user's later change survives
    writeFileSync(process.env.KERNAL_VOICE_SETTINGS, JSON.stringify({ voice: { backend: "deepgram", deepgramApiKey: "k" }, theme: "dark" }));
    const pi2 = makePi(); mod.default(pi2 as any);
    const again = JSON.parse(readFileSync(process.env.KERNAL_VOICE_SETTINGS, "utf8"));
    assert.deepEqual(again, { voice: { backend: "deepgram", deepgramApiKey: "k" }, theme: "dark" });
    const ctx2 = makeCtx({}); await pi2.emit("session_start", {}, ctx2);
    assert.ok(!ctx2.notices.some((n) => n.msg.includes("Voice input ready")));
    delete process.env.KERNAL_VOICE_SETTINGS;
  });
  /** Runs with these env vars set, and puts the environment back even if an assertion fails. */
  async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
    const keys = ["KERNAL_VOICE_SETTINGS", "DEEPGRAM_API_KEY", "KERNAL_VOICE_MODEL", ...Object.keys(vars)];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
    try { await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }
  const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));

  test("#249: key arrives, seed comes out and it says so; key goes, seed comes back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kernal-voice-"));
    const settings = join(dir, "agent", "settings.json");
    const markerPath = join(dir, "agent", "kernal-voice-seed.json");
    await withEnv({ KERNAL_VOICE_SETTINGS: settings }, async () => {
      mod.default(makePi() as any); // first launch, no key: seeded
      // pi-listen then completes its onboarding on its own, keeping only the fields it knows
      const s = read(settings);
      writeFileSync(settings, JSON.stringify({ ...s, voice: { ...s.voice, onboarding: { completed: true, source: "migration" } } }));

      process.env.DEEPGRAM_API_KEY = "dg-test";
      const pi = makePi(); mod.default(pi as any);
      assert.equal(read(settings).voice.backend, undefined, "back to pi-listen's default: Deepgram");
      assert.equal(read(settings).voice.onboarding.completed, true);
      assert.equal(read(markerPath).state, "unseeded");
      const ctx = makeCtx({}); await pi.emit("session_start", {}, ctx);
      assert.ok(ctx.notices.some((n) => n.msg.includes("streams live through Deepgram")));

      delete process.env.DEEPGRAM_API_KEY; // e.g. a checkout with no .env
      const pi2 = makePi(); mod.default(pi2 as any);
      assert.equal(read(settings).voice.backend, "local", "no key: local again, not a keyless Deepgram");
      assert.equal(read(markerPath).state, "seeded");
      const ctx2 = makeCtx({}); await pi2.emit("session_start", {}, ctx2);
      assert.ok(ctx2.notices.some((n) => n.msg.includes("back on the local model")));
    });
  });
  test("#249: a key typed into pi-listen's own settings counts too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kernal-voice-"));
    const settings = join(dir, "agent", "settings.json");
    await withEnv({ KERNAL_VOICE_SETTINGS: settings }, () => {
      mod.default(makePi() as any);
      const s = read(settings);
      writeFileSync(settings, JSON.stringify({ ...s, voice: { ...s.voice, deepgramApiKey: "typed" } }));
      mod.default(makePi() as any);
      assert.equal(read(settings).voice.backend, undefined);
      assert.equal(read(settings).voice.deepgramApiKey, "typed");
    });
  });
  test("#249: the person's own change drops the marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kernal-voice-"));
    const settings = join(dir, "agent", "settings.json");
    const markerPath = join(dir, "agent", "kernal-voice-seed.json");
    await withEnv({ KERNAL_VOICE_SETTINGS: settings }, () => {
      mod.default(makePi() as any);
      assert.ok(existsSync(markerPath));
      const s = read(settings);
      writeFileSync(settings, JSON.stringify({ ...s, voice: { ...s.voice, localModel: "whisper-turbo" } }));
      mod.default(makePi() as any);
      assert.equal(existsSync(markerPath), false);
      assert.equal(read(settings).voice.localModel, "whisper-turbo");
    });
  });
  test("#249: an earlier seed whose model was downloaded stays (the person used it)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kernal-voice-"));
    const settings = join(dir, "agent", "settings.json");
    mkdirSync(join(dir, "agent"), { recursive: true });
    mkdirSync(join(dir, "models", DEFAULT_VOICE_MODEL), { recursive: true });
    const used = { voice: { backend: "local", localModel: DEFAULT_VOICE_MODEL, onboarding: { completed: true, source: "migration" } } };
    writeFileSync(settings, JSON.stringify(used));
    await withEnv({ KERNAL_VOICE_SETTINGS: settings, DEEPGRAM_API_KEY: "dg-test" }, () => {
      mod.default(makePi() as any);
      assert.deepEqual(read(settings), used);
    });
  });
  test("KERNAL_VOICE=off leaves everything alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "kernal-voice-"));
    process.env.KERNAL_VOICE_SETTINGS = join(dir, "settings.json"); process.env.KERNAL_VOICE = "off";
    const pi = makePi(); mod.default(pi as any);
    assert.ok(!existsSync(process.env.KERNAL_VOICE_SETTINGS)); assert.equal(pi.handlers.size, 0);
    delete process.env.KERNAL_VOICE; delete process.env.KERNAL_VOICE_SETTINGS;
  });
});
