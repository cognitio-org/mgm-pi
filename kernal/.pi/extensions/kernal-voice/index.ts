/**
 * Makes pi-listen work out of the box: seeds a local speech backend into the user's global pi
 * settings at extension load time (before pi-listen's session_start reads it), takes that seed back
 * out once a Deepgram key is available (#249), and warns when no audio capture tool is installed.
 * Set KERNAL_VOICE_MODEL to pick another local model, or KERNAL_VOICE=off to leave pi-listen's
 * configuration alone.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { seedVoiceDefaults, unseedVoiceDefaults, languageFromLocale, audioToolHint, AUDIO_TOOLS, type SeedMarker } from "./lib.ts";
import { env } from "../_shared/env.ts";

/** pi-listen's global settings file (it ignores PI_CODING_AGENT_DIR); overridable for tests. */
export const voiceSettingsPath = () => env("VOICE_SETTINGS") || join(homedir(), ".pi", "agent", "settings.json");
/** kernal's note that it wrote the seed, beside pi-listen's settings. */
export const voiceSeedMarkerPath = () => join(dirname(voiceSettingsPath()), "kernal-voice-seed.json");
/** Where pi-listen keeps downloaded models: ~/.pi/models/<id>. */
const modelDir = (model: string) => join(dirname(dirname(voiceSettingsPath())), "models", model);

/** Temp file + rename, as pi-listen writes it: a crash mid-write can't leave half a settings file. */
function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

export function seedFile(): { changed: boolean; reason: string; path: string; unseeded: boolean } {
  const path = voiceSettingsPath();
  const markerPath = voiceSeedMarkerPath();
  let settings: Record<string, any> = readJson(path) ?? {};
  const marker: SeedMarker | undefined = readJson(markerPath);
  const deepgramKey = !!process.env.DEEPGRAM_API_KEY || !!settings.voice?.deepgramApiKey;

  const un = unseedVoiceDefaults(settings, { marker, deepgramKey, modelDownloaded: existsSync(modelDir(settings.voice?.localModel ?? "")) });
  if (un.changed) { writeJsonAtomic(path, un.settings); settings = un.settings; }
  if (un.dropMarker) rmSync(markerPath, { force: true });
  if (un.changed) return { changed: false, reason: un.reason, path, unseeded: true };

  const r = seedVoiceDefaults(settings, { model: env("VOICE_MODEL"), language: languageFromLocale(process.env.LANG), deepgramKeyInEnv: !!process.env.DEEPGRAM_API_KEY });
  if (r.changed) {
    writeJsonAtomic(path, r.settings);
    writeJsonAtomic(markerPath, { backend: "local", localModel: r.settings.voice.localModel, seededAt: new Date().toISOString() } satisfies SeedMarker);
  }
  return { changed: r.changed, reason: r.reason, path, unseeded: false };
}

export function findAudioTool(): string | undefined {
  for (const t of AUDIO_TOOLS) { try { execFileSync("which", [t], { stdio: "ignore" }); return t; } catch {} }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  if (env("VOICE") === "off") return;
  const seeded = seedFile();   // at load time: runs before any extension's session_start
  if (env("VOICE_DEBUG")) console.error(`[kernal-voice] ${seeded.reason} → ${seeded.path}`);
  pi.on("session_start", async (_e, ctx) => {
    if (!ctx.hasUI) return;
    if (seeded.changed) ctx.ui.notify(`Voice input ready: local model ${env("VOICE_MODEL") || "parakeet-v3"} (downloads on first use). Hold Space to talk; /voice-settings to change.`, "info");
    if (seeded.unseeded) ctx.ui.notify("Voice input now streams live through Deepgram (your key is set). Hold Space to talk; /voice-settings to change.", "info");
    const hint = audioToolHint(findAudioTool(), process.platform);
    if (hint) ctx.ui.notify(hint, "warning");
  });
}
