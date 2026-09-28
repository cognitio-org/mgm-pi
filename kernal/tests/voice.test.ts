import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedVoiceDefaults, unseedVoiceDefaults, languageFromLocale, audioToolHint, DEFAULT_VOICE_MODEL } from "../.pi/extensions/kernal-voice/lib.ts";
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

describe("unseedVoiceDefaults (#249)", () => {
  const seeded = { voice: { enabled: true, backend: "local", localModel: DEFAULT_VOICE_MODEL, language: "en", onboarding: { completed: true } } };
  const marker = { backend: "local" as const, localModel: DEFAULT_VOICE_MODEL, seededAt: "2026-09-19T00:00:00Z" };

  test("with a key, takes out kernal's own seed and keeps everything else", () => {
    const r = unseedVoiceDefaults(seeded, { marker, deepgramKey: true, modelDownloaded: true });
    assert.equal(r.changed, true);
    assert.equal(r.dropMarker, true);
    assert.deepEqual(r.settings.voice, { enabled: true, language: "en", onboarding: { completed: true } });
  });
  test("no key: leaves it", () => {
    const r = unseedVoiceDefaults(seeded, { marker, deepgramKey: false, modelDownloaded: false });
    assert.equal(r.changed, false);
    assert.equal(r.dropMarker, false);
  });
  test("the person chose another model or backend since: theirs now, and the marker goes", () => {
    const other = unseedVoiceDefaults({ voice: { ...seeded.voice, localModel: "whisper-turbo" } }, { marker, deepgramKey: true, modelDownloaded: false });
    assert.deepEqual([other.changed, other.dropMarker], [false, true]);
    const deepgram = unseedVoiceDefaults({ voice: { onboarding: { completed: true } } }, { marker, deepgramKey: true, modelDownloaded: false });
    assert.deepEqual([deepgram.changed, deepgram.dropMarker], [false, true]);
  });
  test("a seed from before the marker counts as kernal's only if its model was never downloaded", () => {
    const unused = unseedVoiceDefaults(seeded, { deepgramKey: true, modelDownloaded: false });
    assert.equal(unused.changed, true);
    const used = unseedVoiceDefaults(seeded, { deepgramKey: true, modelDownloaded: true });
    assert.equal(used.changed, false);
    const otherModel = unseedVoiceDefaults({ voice: { ...seeded.voice, localModel: "moonshine-base" } }, { deepgramKey: true, modelDownloaded: false });
    assert.equal(otherModel.changed, false);
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
    assert.equal(marker.localModel, DEFAULT_VOICE_MODEL, "the seed is marked as kernal's");
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
  test("#249: once a Deepgram key arrives, the seed comes out, the marker goes, and it says so", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kernal-voice-"));
    process.env.KERNAL_VOICE_SETTINGS = join(dir, "agent", "settings.json");
    delete process.env.DEEPGRAM_API_KEY; delete process.env.KERNAL_VOICE_MODEL;
    mod.default(makePi() as any); // first launch, no key: seeded
    // pi-listen then marks its onboarding done, keeping only the fields it knows
    const s = JSON.parse(readFileSync(process.env.KERNAL_VOICE_SETTINGS, "utf8"));
    writeFileSync(process.env.KERNAL_VOICE_SETTINGS, JSON.stringify({ ...s, voice: { ...s.voice, onboarding: { completed: true, source: "migration" } } }));
    process.env.DEEPGRAM_API_KEY = "dg-test";
    const pi = makePi(); mod.default(pi as any);
    const after = JSON.parse(readFileSync(process.env.KERNAL_VOICE_SETTINGS, "utf8"));
    assert.equal(after.voice.backend, undefined, "back to pi-listen's default: Deepgram");
    assert.equal(after.voice.localModel, undefined);
    assert.equal(after.voice.onboarding.completed, true);
    assert.equal(existsSync(join(dir, "agent", "kernal-voice-seed.json")), false);
    const ctx = makeCtx({}); await pi.emit("session_start", {}, ctx);
    assert.ok(ctx.notices.some((n) => n.msg.includes("streams live through Deepgram")));
    // a later launch without the key in the shell doesn't seed local again
    delete process.env.DEEPGRAM_API_KEY;
    mod.default(makePi() as any);
    assert.equal(JSON.parse(readFileSync(process.env.KERNAL_VOICE_SETTINGS, "utf8")).voice.backend, undefined);
    delete process.env.KERNAL_VOICE_SETTINGS;
  });
  test("#249: a pre-marker seed whose model was downloaded stays (the person used it)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kernal-voice-"));
    process.env.KERNAL_VOICE_SETTINGS = join(dir, "agent", "settings.json");
    mkdirSync(join(dir, "agent"), { recursive: true });
    mkdirSync(join(dir, "models", DEFAULT_VOICE_MODEL), { recursive: true });
    const used = { voice: { backend: "local", localModel: DEFAULT_VOICE_MODEL, onboarding: { completed: true } } };
    writeFileSync(process.env.KERNAL_VOICE_SETTINGS, JSON.stringify(used));
    process.env.DEEPGRAM_API_KEY = "dg-test";
    mod.default(makePi() as any);
    assert.deepEqual(JSON.parse(readFileSync(process.env.KERNAL_VOICE_SETTINGS, "utf8")), used);
    delete process.env.DEEPGRAM_API_KEY; delete process.env.KERNAL_VOICE_SETTINGS;
  });
  test("KERNAL_VOICE=off leaves everything alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "kernal-voice-"));
    process.env.KERNAL_VOICE_SETTINGS = join(dir, "settings.json"); process.env.KERNAL_VOICE = "off";
    const pi = makePi(); mod.default(pi as any);
    assert.ok(!existsSync(process.env.KERNAL_VOICE_SETTINGS)); assert.equal(pi.handlers.size, 0);
    delete process.env.KERNAL_VOICE; delete process.env.KERNAL_VOICE_SETTINGS;
  });
});
