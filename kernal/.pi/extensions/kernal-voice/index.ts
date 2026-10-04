/**
 * Makes pi-listen work out of the box: seeds a local speech backend into the user's global pi
 * settings at extension load time (before pi-listen's session_start reads it), takes that seed back
 * out once a Deepgram key is available (#249), and warns when no audio capture tool is installed.
 * Set KERNAL_VOICE_MODEL to pick another local model, or KERNAL_VOICE=off to leave pi-listen's
 * configuration alone.
 *
 * Centrally managed voice.enabled and voice.language (#437) are written over the seed at load, and
 * again by /config reload and the start-up refresh (_shared/central-apply.ts applyVoiceSettings);
 * pi-listen picks them up at its next session_start.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { reconcileVoice, languageFromLocale, audioToolHint, AUDIO_TOOLS, DEFAULT_VOICE_MODEL, type Reconcile } from "./lib.ts";
import { env } from "../_shared/env.ts";
import { applyVoiceSettings } from "../_shared/central-apply.ts";

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
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

export type SeedOutcome = { notice?: Reconcile["notice"]; reason: string; path: string };

export function seedFile(): SeedOutcome {
  const path = voiceSettingsPath();
  const markerPath = voiceSeedMarkerPath();
  const settings: Record<string, any> = readJson(path) ?? {};
  const r = reconcileVoice(settings, {
    marker: readJson(markerPath),
    deepgramKey: !!process.env.DEEPGRAM_API_KEY || !!settings.voice?.deepgramApiKey,
    modelDownloaded: existsSync(modelDir(settings.voice?.localModel ?? DEFAULT_VOICE_MODEL)),
    model: env("VOICE_MODEL"),
    language: languageFromLocale(process.env.LANG),
  });
  if (r.changed) writeJsonAtomic(path, r.settings);
  if (r.marker) writeJsonAtomic(markerPath, r.marker);
  else rmSync(markerPath, { force: true });
  return { notice: r.notice, reason: r.reason, path };
}

export function findAudioTool(): string | undefined {
  for (const t of AUDIO_TOOLS) { try { execFileSync("which", [t], { stdio: "ignore" }); return t; } catch {} }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  if (env("VOICE") === "off") return;
  // At load time: runs before any extension's session_start. A failure (a full disk, a read-only
  // home) must not stop kernal starting; voice just stays as it was.
  let seeded: SeedOutcome;
  try {
    seeded = seedFile();
  } catch (err) {
    seeded = { reason: `left alone: ${err instanceof Error ? err.message : String(err)}`, path: voiceSettingsPath() };
    console.error(`[kernal-voice] couldn't update voice settings: ${seeded.reason}`);
  }
  if (env("VOICE_DEBUG")) console.error(`[kernal-voice] ${seeded.reason} → ${seeded.path}`);
  // #437: voice.enabled and voice.language from the account (or this machine's config.local.json)
  // go over the seed, so pi-listen's session_start reads them. A legacy pi-listen value is left as
  // it is. Never throws.
  const central = applyVoiceSettings();
  if (env("VOICE_DEBUG") && central.length) console.error(`[kernal-voice] central settings applied: ${central.join(", ")}`);
  pi.on("session_start", async (_e, ctx) => {
    if (!ctx.hasUI) return;
    const model = env("VOICE_MODEL") || DEFAULT_VOICE_MODEL;
    if (seeded.notice === "seeded") ctx.ui.notify(`Voice input ready: local model ${model} (downloads on first use). Hold Space to talk; /voice-settings to change.`, "info");
    if (seeded.notice === "unseeded") ctx.ui.notify("Voice input now streams live through Deepgram (your key is set). Hold Space to talk; /voice-settings to change.", "info");
    if (seeded.notice === "reseeded") ctx.ui.notify(`No Deepgram key now, so voice input is back on the local model ${model}. Hold Space to talk.`, "info");
    const hint = audioToolHint(findAudioTool(), process.platform);
    if (hint) ctx.ui.notify(hint, "warning");
  });
}
