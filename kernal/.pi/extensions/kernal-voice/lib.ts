/**
 * Voice defaults for pi-listen, so hold-to-talk (hold Space) works out of the box.
 *
 * pi-listen reads `voice` from the user's global ~/.pi/agent/settings.json (it does not follow
 * PI_CODING_AGENT_DIR) and defaults to Deepgram, a cloud backend that needs an API key. When a
 * local backend and model are configured it activates itself with no onboarding, downloading the
 * model on first use. kernal seeds that configuration once, and never overrides a user's own choice.
 *
 * The seed is only a stand-in for a Deepgram key (#249): once a key turns up, kernal takes its own
 * seed back out so pi-listen streams live through Deepgram, and puts it back if the key goes away.
 * It tracks that in a marker file beside the settings (pi-listen rewrites its settings with known
 * fields only, so the mark can't live there); see reconcileVoice.
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

/**
 * kernal's note beside pi-listen's settings (see voiceSeedMarkerPath): "seeded" while its local seed
 * stands in for a missing key, "unseeded" after it took that seed out for a key, so it can put it
 * back if the key goes away again.
 */
export type SeedMarker = { state: "seeded"; localModel: string; at: string } | { state: "unseeded"; at: string };

export type Reconcile = {
  settings: Record<string, any>;
  changed: boolean;
  /** The marker to keep (undefined: delete it). */
  marker?: SeedMarker;
  notice?: "seeded" | "unseeded" | "reseeded";
  reason: string;
};

function withoutSeed(settings: Record<string, any>): Record<string, any> {
  const { backend: _b, localModel: _m, ...rest } = settings.voice ?? {};
  return { ...settings, voice: rest };
}

/**
 * Decides what kernal does to pi-listen's voice settings at load (#249). Its local seed only stands
 * in for a Deepgram key: it comes out once a key is available and goes back if the key goes away.
 * Anything the person chose is theirs, and the marker is dropped the moment the settings stop
 * matching kernal's seed. Settings can't tell a deliberate re-pick of the very same local model from
 * the seed; that one case is treated as the seed.
 */
export function reconcileVoice(
  settings: Record<string, any>,
  opts: { marker?: SeedMarker; deepgramKey: boolean; modelDownloaded: boolean; model?: string; language?: string; now?: string },
): Reconcile {
  const voice = settings.voice && typeof settings.voice === "object" ? settings.voice : {};
  const at = opts.now ?? new Date().toISOString();
  const same = { settings, changed: false };
  const m = opts.marker;

  if (m?.state === "seeded") {
    if (voice.backend !== "local" || voice.localModel !== m.localModel) return { ...same, reason: "the person changed voice since kernal seeded it" };
    if (!opts.deepgramKey) return { ...same, marker: m, reason: "seed still standing in for a key" };
    return { settings: withoutSeed(settings), changed: true, marker: { state: "unseeded", at }, notice: "unseeded", reason: "Deepgram key present: took kernal's seed out" };
  }

  if (m?.state === "unseeded") {
    if (voice.backend || voice.enabled === false) return { ...same, reason: "the person chose voice settings since" };
    if (opts.deepgramKey) return { ...same, marker: m, reason: "on Deepgram with a key" };
    const localModel = opts.model || DEFAULT_VOICE_MODEL;
    const reseeded = { ...settings, voice: { ...voice, enabled: true, backend: "local", localModel } };
    return { settings: reseeded, changed: true, marker: { state: "seeded", localModel, at }, notice: "reseeded", reason: "no key any more: put the local seed back" };
  }

  // No marker. A seed from before kernal kept one counts as kernal's only if pi-listen completed its
  // onboarding on its own ("migration", as it does right after a seed) and the model was never
  // downloaded, so nothing the person picked or used is removed.
  const legacySeed =
    voice.backend === "local" && voice.localModel === DEFAULT_VOICE_MODEL && voice.onboarding?.source === "migration" && !opts.modelDownloaded;
  if (legacySeed && opts.deepgramKey) {
    return { settings: withoutSeed(settings), changed: true, marker: { state: "unseeded", at }, notice: "unseeded", reason: "Deepgram key present: took an unused earlier seed out" };
  }
  const r = seedVoiceDefaults(settings, { model: opts.model, language: opts.language, deepgramKeyInEnv: opts.deepgramKey });
  if (!r.changed) return { ...same, reason: r.reason };
  return { settings: r.settings, changed: true, marker: { state: "seeded", localModel: r.settings.voice.localModel, at }, notice: "seeded", reason: r.reason };
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
