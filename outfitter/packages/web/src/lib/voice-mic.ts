// #267: which microphone the Deepgram engine records from. The choice is remembered per browser:
// device ids are per origin and per browser, so they mean nothing to the server or another machine.
// The built-in engine (SpeechRecognition) can't be pointed at a device; it always uses the system
// default.

export interface Mic {
  id: string;
  label: string;
}

export const MIC_STORAGE_KEY = "outfitter.voice.micId";

/** The audio inputs, minus Chrome's "default" and "communications" aliases (the menu offers its own
 * "System default"). `labelled` is false until mic permission has been granted once: browsers hide
 * the names (and often all but one entry) before that. */
export async function listMics(devices: Pick<MediaDevices, "enumerateDevices"> | undefined): Promise<{ mics: Mic[]; labelled: boolean }> {
  if (!devices?.enumerateDevices) return { mics: [], labelled: false };
  const all = await devices.enumerateDevices();
  const inputs = all.filter((d) => d.kind === "audioinput" && d.deviceId !== "default" && d.deviceId !== "communications");
  const labelled = inputs.some((d) => d.label);
  return { mics: inputs.filter((d) => d.deviceId).map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` })), labelled };
}

/** The audio constraints for a recording: the chosen device exactly, or the browser's default. */
export function micConstraints(deviceId: string | undefined): MediaTrackConstraints {
  return { echoCancellation: true, noiseSuppression: true, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) };
}

/** The saved choice, or undefined for the system default. Storage can throw (private mode). */
export function loadMicId(storage: Pick<Storage, "getItem"> | undefined = safeLocalStorage()): string | undefined {
  try {
    return storage?.getItem(MIC_STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

export function saveMicId(id: string | undefined, storage: Pick<Storage, "setItem" | "removeItem"> | undefined = safeLocalStorage()): void {
  try {
    if (id) storage?.setItem(MIC_STORAGE_KEY, id);
    else storage?.removeItem(MIC_STORAGE_KEY);
  } catch {
    // not persisted; the choice still holds for this page
  }
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
