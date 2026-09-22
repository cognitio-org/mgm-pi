/**
 * Makes pi-listen work out of the box: seeds a local speech backend into the user's global pi
 * settings at extension load time (before pi-listen's session_start reads it) and warns when no
 * audio capture tool is installed. Set KERNAL_VOICE_MODEL to pick another local model, or
 * KERNAL_VOICE=off to leave pi-listen's configuration alone.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { seedVoiceDefaults, languageFromLocale, audioToolHint, AUDIO_TOOLS } from "./lib.ts";
import { env } from "../_shared/env.ts";

/** pi-listen's global settings file (it ignores PI_CODING_AGENT_DIR); overridable for tests. */
export const voiceSettingsPath = () => env("VOICE_SETTINGS") || join(homedir(), ".pi", "agent", "settings.json");

export function seedFile(): { changed: boolean; reason: string; path: string } {
  const path = voiceSettingsPath();
  let settings: Record<string, any> = {};
  try { settings = JSON.parse(readFileSync(path, "utf8")); } catch {}
  const r = seedVoiceDefaults(settings, { model: env("VOICE_MODEL"), language: languageFromLocale(process.env.LANG), deepgramKeyInEnv: !!process.env.DEEPGRAM_API_KEY });
  if (r.changed) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, JSON.stringify(r.settings, null, 2) + "\n"); }
  return { ...r, path };
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
    if (seeded.changed) ctx.ui.notify(`Voice input ready: local model ${env("VOICE_MODEL") || "parakeet-v3"} (downloads on first use). Hold ctrl+shift+v to talk; /voice-settings to change.`, "info");
    const hint = audioToolHint(findAudioTool(), process.platform);
    if (hint) ctx.ui.notify(hint, "warning");
  });
}
