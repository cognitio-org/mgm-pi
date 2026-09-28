// #250: kernal's vendored fork of pi-listen (kernal/.pi/npm/vendor/pi-listen, VENDORED.md). The fixes
// are small pure decisions in voice/kernal.ts, tested here; the extension itself is loaded under the
// harness to prove the fork still starts and registers its commands, and config.ts's merge is tested
// through the real loader with temp settings files.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  rearmReleaseOnRepeat,
  autoSpeakAllowed,
  streamLogPath,
  mergeVoiceBlocks,
  ffplayChannelArgs,
  linuxFilePlayer,
} from "../.pi/npm/vendor/pi-listen/extensions/voice/kernal.ts";
import { loadConfigWithSource } from "../.pi/npm/vendor/pi-listen/extensions/voice/config.ts";
import { makePi } from "./harness.ts";

describe("hold Space: re-arm the release timer on repeats (upstream #13)", () => {
  test("while recording, on a terminal that hasn't shown a release event: re-arm", () => {
    assert.equal(rearmReleaseOnRepeat({ voiceState: "recording", spaceConsumed: true, kittyReleaseDetected: false }), true);
    // The async start: consumed but not yet "recording".
    assert.equal(rearmReleaseOnRepeat({ voiceState: "warmup", spaceConsumed: true, kittyReleaseDetected: false }), true);
  });
  test("a terminal that sends release events stops on the release, not the gap", () => {
    assert.equal(rearmReleaseOnRepeat({ voiceState: "recording", spaceConsumed: true, kittyReleaseDetected: true }), false);
  });
  test("finalizing, nothing consumed: the recording is already ending, nothing to re-arm", () => {
    assert.equal(rearmReleaseOnRepeat({ voiceState: "finalizing", spaceConsumed: false, kittyReleaseDetected: false }), false);
  });
});

describe("spoken replies need a UI", () => {
  const on = { ttsEnabled: true, ttsAutoSpeak: true };
  test("with a UI and both settings on: speak", () => assert.equal(autoSpeakAllowed(on, true), true));
  test("print mode, subagents, scripted runs (no UI): never", () => {
    assert.equal(autoSpeakAllowed(on, false), false);
    assert.equal(autoSpeakAllowed(on, undefined), false);
  });
  test("either setting off: no", () => {
    assert.equal(autoSpeakAllowed({ ttsEnabled: true, ttsAutoSpeak: false }, true), false);
    assert.equal(autoSpeakAllowed({ ttsEnabled: false, ttsAutoSpeak: true }, true), false);
  });
});

describe("the stream log", () => {
  test("off unless PI_VOICE_DEBUG is set, and then in the OS temp dir", () => {
    assert.equal(streamLogPath({}, "/var/folders/x/T/"), undefined);
    assert.equal(streamLogPath({ PI_VOICE_DEBUG: "1" }, "/var/folders/x/T/"), "/var/folders/x/T/pi-listen-stream.log");
  });
});

describe("project voice settings merge over the global ones", () => {
  test("key by key: the project's language, the global backend, model and key", () => {
    const merged = mergeVoiceBlocks({ backend: "local", localModel: "parakeet-v3", deepgramApiKey: "k", language: "en" }, { language: "de" });
    assert.deepEqual(merged, { backend: "local", localModel: "parakeet-v3", deepgramApiKey: "k", language: "de" });
    assert.deepEqual(mergeVoiceBlocks(undefined, { language: "de" }), { language: "de" });
  });
  test("through the real loader, with temp settings files", () => {
    const home = mkdtempSync(join(tmpdir(), "pl-agent-"));
    const project = mkdtempSync(join(tmpdir(), "pl-project-"));
    writeFileSync(join(home, "settings.json"), JSON.stringify({ voice: { backend: "local", localModel: "parakeet-v3", language: "en" } }));
    mkdirSync(join(project, ".pi"));
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ voice: { language: "de" } }));
    const loaded = loadConfigWithSource(project, { agentDir: home });
    assert.equal(loaded.source, "project");
    assert.equal(loaded.config.language, "de");
    assert.equal(loaded.config.backend, "local", "the global backend survives a project block");
    assert.equal(loaded.config.localModel, "parakeet-v3");
  });
});

describe("Linux playback (upstream #6)", () => {
  test("ffplay's mono flag by version: -ac below 5.1 (Ubuntu 22.04's 4.4), -ch_layout from 5.1", () => {
    assert.deepEqual(ffplayChannelArgs("4.4.2-0ubuntu0.22.04.1"), ["-ac", "1"]);
    assert.deepEqual(ffplayChannelArgs("5.0.1"), ["-ac", "1"]);
    assert.deepEqual(ffplayChannelArgs("5.1"), ["-ch_layout", "mono"]);
    assert.deepEqual(ffplayChannelArgs("6.1.1-3ubuntu5"), ["-ch_layout", "mono"]);
    assert.deepEqual(ffplayChannelArgs("7.1"), ["-ch_layout", "mono"]);
    assert.deepEqual(ffplayChannelArgs(undefined), ["-ch_layout", "mono"]);
  });
  test("paplay when it's there, aplay when only ALSA is", () => {
    assert.equal(linuxFilePlayer(() => true).cmd, "paplay");
    const alsa = linuxFilePlayer((c) => c === "aplay");
    assert.equal(alsa.cmd, "aplay");
    assert.deepEqual(alsa.args("/tmp/a.wav"), ["-q", "/tmp/a.wav"]);
    assert.equal(linuxFilePlayer(() => false).cmd, "paplay", "neither: paplay, so the error names the usual player");
  });
});

describe("the vendored extension still loads", () => {
  test("registers its commands and hooks, and writes no stream log without PI_VOICE_DEBUG", async () => {
    const savedHome = process.env.HOME;
    const savedDebug = process.env.PI_VOICE_DEBUG;
    process.env.HOME = mkdtempSync(join(tmpdir(), "pl-home-"));
    delete process.env.PI_VOICE_DEBUG;
    try {
      const mod = await import("../.pi/npm/vendor/pi-listen/extensions/voice.ts");
      const pi = makePi() as any;
      pi.registerShortcut = () => {};
      mod.default(pi);
      for (const name of ["voice", "voice-settings", "voice-help", "voice-speak", "voice-speak-toggle"]) assert.ok(pi.commands.has(name), `missing /${name}`);
      assert.ok(pi.handlers.has("session_start"));
      assert.ok(pi.handlers.has("message_update"));
      // A streamed assistant update used to append to /tmp/pi-listen-stream.log on every token.
      const log = join(tmpdir(), "pi-listen-stream.log");
      const existed = existsSync(log);
      await pi.emit("message_update", { message: { role: "assistant", id: "m1", content: [{ type: "text", text: "hi" }] } }, { hasUI: false });
      if (!existed) assert.equal(existsSync(log), false);
    } finally {
      process.env.HOME = savedHome;
      if (savedDebug !== undefined) process.env.PI_VOICE_DEBUG = savedDebug;
    }
  });
});
