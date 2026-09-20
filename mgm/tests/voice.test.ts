import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedVoiceDefaults, languageFromLocale, audioToolHint, DEFAULT_VOICE_MODEL } from "../.pi/extensions/mgm-voice/lib.ts";
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
    assert.match(audioToolHint(undefined, "linux")!, /apt install sox/);
    assert.equal(audioToolHint("rec", "darwin"), undefined);
  });
});

describe("mgm-voice extension", async () => {
  const mod = await import("../.pi/extensions/mgm-voice/index.ts");
  test("seeds pi-listen's global settings file at load time and notifies once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mgm-voice-"));
    process.env.MGM_VOICE_SETTINGS = join(dir, "agent", "settings.json");
    delete process.env.DEEPGRAM_API_KEY; delete process.env.MGM_VOICE_MODEL;
    const pi = makePi(); mod.default(pi as any);
    assert.ok(existsSync(process.env.MGM_VOICE_SETTINGS), "file created, directories too");
    const saved = JSON.parse(readFileSync(process.env.MGM_VOICE_SETTINGS, "utf8"));
    assert.equal(saved.voice.backend, "local"); assert.equal(saved.voice.localModel, DEFAULT_VOICE_MODEL);
    const ctx = makeCtx({}); await pi.emit("session_start", {}, ctx);
    assert.ok(ctx.notices.some((n) => n.msg.includes("Voice input ready")));
    // second load: nothing to seed, no "ready" notice; a user's later change survives
    writeFileSync(process.env.MGM_VOICE_SETTINGS, JSON.stringify({ voice: { backend: "deepgram", deepgramApiKey: "k" }, theme: "dark" }));
    const pi2 = makePi(); mod.default(pi2 as any);
    const again = JSON.parse(readFileSync(process.env.MGM_VOICE_SETTINGS, "utf8"));
    assert.deepEqual(again, { voice: { backend: "deepgram", deepgramApiKey: "k" }, theme: "dark" });
    const ctx2 = makeCtx({}); await pi2.emit("session_start", {}, ctx2);
    assert.ok(!ctx2.notices.some((n) => n.msg.includes("Voice input ready")));
    delete process.env.MGM_VOICE_SETTINGS;
  });
  test("MGM_VOICE=off leaves everything alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "mgm-voice-"));
    process.env.MGM_VOICE_SETTINGS = join(dir, "settings.json"); process.env.MGM_VOICE = "off";
    const pi = makePi(); mod.default(pi as any);
    assert.ok(!existsSync(process.env.MGM_VOICE_SETTINGS)); assert.equal(pi.handlers.size, 0);
    delete process.env.MGM_VOICE; delete process.env.MGM_VOICE_SETTINGS;
  });
});
