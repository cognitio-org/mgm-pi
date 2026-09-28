/**
 * Kernal's changes to pi-listen as small pure decisions, so they're unit-tested
 * (kernal/tests/pi-listen-vendored.test.ts) instead of living only inside voice.ts's closures.
 * See ../../VENDORED.md.
 */

export type HoldVoiceState = "idle" | "warmup" | "recording" | "finalizing";

/**
 * A Space key-repeat that arrives while a hold is recording: must it re-arm the gap-based release
 * timer? (upstream #13) Recording start clears that timer. On a terminal that sends Kitty repeat
 * events but no release events, the gap in repeats is the only sign you let go, so every repeat has
 * to re-arm it, or the recording never ends. Once a real release event has been seen, the release
 * handler stops the recording and the gap timer isn't needed.
 */
export function rearmReleaseOnRepeat(s: { voiceState: HoldVoiceState; spaceConsumed: boolean; kittyReleaseDetected: boolean }): boolean {
	if (s.kittyReleaseDetected) return false;
	return s.voiceState === "recording" || s.spaceConsumed;
}

/** Auto-speak only with a UI: `pi -p`, subagents and scripted runs mustn't read replies aloud. */
export function autoSpeakAllowed(config: { ttsEnabled?: boolean; ttsAutoSpeak?: boolean }, hasUI: boolean | undefined): boolean {
	return !!config.ttsEnabled && !!config.ttsAutoSpeak && hasUI === true;
}

/**
 * Where the streaming diagnostics go: nowhere unless PI_VOICE_DEBUG is set, and then the OS temp
 * dir. (Upstream appended to /tmp/pi-listen-stream.log on every stream, with no size limit.)
 */
export function streamLogPath(env: Record<string, string | undefined>, tmpdir: string): string | undefined {
	return env.PI_VOICE_DEBUG ? `${tmpdir.replace(/\/+$/, "")}/pi-listen-stream.log` : undefined;
}

/** A project "voice" block overrides the global one key by key (upstream replaced it wholesale). */
export function mergeVoiceBlocks(globalVoice: unknown, projectVoice: Record<string, unknown>): Record<string, unknown> {
	return globalVoice && typeof globalVoice === "object" ? { ...(globalVoice as Record<string, unknown>), ...projectVoice } : projectVoice;
}

/** ffplay's mono flag for its version: `-ch_layout mono` from ffmpeg 5.1, `-ac 1` before (upstream #6). */
export function ffplayChannelArgs(version: string | undefined): string[] {
	const m = version?.match(/(\d+)\.(\d+)/);
	if (!m) return ["-ch_layout", "mono"];
	const major = Number(m[1]);
	const minor = Number(m[2]);
	return major < 5 || (major === 5 && minor < 1) ? ["-ac", "1"] : ["-ch_layout", "mono"];
}

/** The Linux player for a WAV file: paplay, else aplay when only ALSA is there. */
export function linuxFilePlayer(has: (cmd: string) => boolean): { cmd: string; args: (p: string) => string[] } {
	if (!has("paplay") && has("aplay")) return { cmd: "aplay", args: (p) => ["-q", p] };
	return { cmd: "paplay", args: (p) => [p] };
}
