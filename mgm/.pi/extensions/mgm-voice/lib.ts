/**
 * Voice defaults for pi-listen, so hold-to-talk works out of the box.
 *
 * pi-listen reads `voice` from the user's global ~/.pi/agent/settings.json (it does not follow
 * PI_CODING_AGENT_DIR) and defaults to Deepgram, a cloud backend that needs an API key. When a
 * local backend and model are configured it activates itself with no onboarding, downloading the
 * model on first use. mgm seeds that configuration once, and never overrides a user's own choice.
 */
export const DEFAULT_VOICE_MODEL = "parakeet-v3";   // pi-listen's own recommended local STT model (~671 MB, English + 24 languages)

export type SeedResult = { settings: Record<string, any>; changed: boolean; reason: string };

export function seedVoiceDefaults(settings: Record<string, any>, opts: { model?: string; language?: string; deepgramKeyInEnv?: boolean } = {}): SeedResult {
  const voice = settings.voice && typeof settings.voice === "object" ? settings.voice : {};
  if (voice.backend) return { settings, changed: false, reason: `backend already set (${voice.backend})` };
  if (voice.deepgramApiKey || opts.deepgramKeyInEnv) return { settings, changed: false, reason: "Deepgram key present" };
  if (voice.enabled === false) return { settings, changed: false, reason: "voice disabled by the user" };
  const seeded = {
    ...voice,
    version: voice.version ?? 2,
    enabled: true,
    backend: "local",
    localModel: opts.model || DEFAULT_VOICE_MODEL,
    language: voice.language ?? opts.language ?? "en",
  };
  return { settings: { ...settings, voice: seeded }, changed: true, reason: `seeded local backend with ${seeded.localModel}` };
}

/** Two-letter language from a POSIX locale such as "en_US.UTF-8" or "sl_SI"; "en" when unknown. */
export function languageFromLocale(locale: string | undefined): string {
  const m = (locale || "").match(/^([a-z]{2})(?:[_-]|$)/i);
  return m ? m[1].toLowerCase() : "en";
}

/** pi-listen's audio capture tools in its own priority order. */
export const AUDIO_TOOLS = ["rec", "ffmpeg", "arecord"];
export function audioToolHint(found: string | undefined, platform: string): string | undefined {
  if (found) return undefined;
  const how = platform === "darwin" ? "brew install sox" : platform === "linux" ? "sudo apt install sox   (or ffmpeg)" : "install SoX or ffmpeg";
  return `Voice input (hold ctrl+shift+v) needs an audio capture tool. Install one: ${how}`;
}
