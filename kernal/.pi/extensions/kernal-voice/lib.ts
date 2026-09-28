/**
 * Voice defaults for pi-listen, so hold-to-talk (hold Space) works out of the box.
 *
 * pi-listen reads `voice` from the user's global ~/.pi/agent/settings.json (it does not follow
 * PI_CODING_AGENT_DIR) and defaults to Deepgram, a cloud backend that needs an API key. When a
 * local backend and model are configured it activates itself with no onboarding, downloading the
 * model on first use. kernal seeds that configuration once, and never overrides a user's own choice.
 *
 * The seed is only a stand-in for a Deepgram key (#249): once a key turns up, kernal takes its own
 * seed back out so pi-listen streams live through Deepgram. It knows the seed is its own from a
 * marker file (pi-listen rewrites its settings with known fields only, so the mark can't live
 * there), or, for seeds from before the marker, from the model never having been downloaded.
 */
export const DEFAULT_VOICE_MODEL = "parakeet-v3";   // pi-listen's own recommended local STT model (~671 MB, English + 24 languages)

export type SeedResult = { settings: Record<string, any>; changed: boolean; reason: string };

export function seedVoiceDefaults(settings: Record<string, any>, opts: { model?: string; language?: string; deepgramKeyInEnv?: boolean } = {}): SeedResult {
  const voice = settings.voice && typeof settings.voice === "object" ? settings.voice : {};
  if (voice.backend) return { settings, changed: false, reason: `backend already set (${voice.backend})` };
  if (voice.deepgramApiKey || opts.deepgramKeyInEnv) return { settings, changed: false, reason: "Deepgram key present" };
  if (voice.enabled === false) return { settings, changed: false, reason: "voice disabled by the user" };
  // Set up already (Deepgram is stored as no backend at all): a launch without the key in the
  // environment mustn't turn that choice into a local one.
  if (voice.onboarding?.completed) return { settings, changed: false, reason: "voice already set up" };
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

/** What kernal wrote when it seeded, kept beside pi-listen's settings (see voiceSeedMarkerPath). */
export type SeedMarker = { backend: "local"; localModel: string; seededAt: string };

export type UnseedResult = SeedResult & { dropMarker: boolean };

/**
 * Takes kernal's local seed back out once a Deepgram key is available, so pi-listen's default
 * (Deepgram, live streaming) applies. Only ever kernal's own seed: one matching the marker, or,
 * with no marker, the default model that was never downloaded (so nothing the person used goes).
 */
export function unseedVoiceDefaults(
  settings: Record<string, any>,
  opts: { marker?: SeedMarker; deepgramKey: boolean; modelDownloaded: boolean },
): UnseedResult {
  const voice = settings.voice && typeof settings.voice === "object" ? settings.voice : {};
  const same = { settings, changed: false };
  if (!opts.deepgramKey) return { ...same, reason: "no Deepgram key", dropMarker: false };
  if (voice.backend !== "local") return { ...same, reason: "not on the local backend", dropMarker: !!opts.marker };
  if (opts.marker) {
    if (voice.localModel !== opts.marker.localModel) return { ...same, reason: "the person chose another local model", dropMarker: true };
  } else if (voice.localModel !== DEFAULT_VOICE_MODEL || opts.modelDownloaded) {
    return { ...same, reason: "local backend in use (not an unused kernal seed)", dropMarker: false };
  }
  const { backend: _backend, localModel: _model, ...rest } = voice;
  return { settings: { ...settings, voice: rest }, changed: true, reason: "Deepgram key present: removed kernal's local seed", dropMarker: true };
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
  return `Voice input (hold Space to talk) needs an audio capture tool. Install one: ${how}`;
}
