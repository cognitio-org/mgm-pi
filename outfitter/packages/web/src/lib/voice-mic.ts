// #267: which microphone the Deepgram engine records from. The choice is remembered per browser:
// device ids are per origin and per browser, so they mean nothing to the server or another machine.
// The built-in engine (SpeechRecognition) can't be pointed at a device; it always uses the system
// default.

export interface Mic {
  id: string;
  label: string;
}

export const MIC_STORAGE_KEY = "outfitter.voice.micId";
/** The chosen mic's name, so it's found again when the browser issues new device ids (a private
 * window, cleared site data). */
export const MIC_LABEL_STORAGE_KEY = "outfitter.voice.micLabel";

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

export interface MicChoice {
  id: string;
  label?: string;
}

/** The saved choice, or undefined for the system default. Storage can throw (private mode). */
export function loadMicChoice(storage: Pick<Storage, "getItem"> | undefined = safeLocalStorage()): MicChoice | undefined {
  try {
    const id = storage?.getItem(MIC_STORAGE_KEY);
    if (!id) return undefined;
    const label = storage?.getItem(MIC_LABEL_STORAGE_KEY) || undefined;
    return { id, ...(label ? { label } : {}) };
  } catch {
    return undefined;
  }
}

export function saveMicChoice(choice: MicChoice | undefined, storage: Pick<Storage, "setItem" | "removeItem"> | undefined = safeLocalStorage()): void {
  try {
    if (choice) {
      storage?.setItem(MIC_STORAGE_KEY, choice.id);
      if (choice.label) storage?.setItem(MIC_LABEL_STORAGE_KEY, choice.label);
      else storage?.removeItem(MIC_LABEL_STORAGE_KEY);
    } else {
      storage?.removeItem(MIC_STORAGE_KEY);
      storage?.removeItem(MIC_LABEL_STORAGE_KEY);
    }
  } catch {
    // not persisted; the choice still holds for this page
  }
}

/** The saved choice against the mics connected now: its id if that's there, else the one mic with
 * its name (the browser issued new ids), else the id as saved (not connected). Two mics with the same
 * name are never guessed between: unplugging one of a pair mustn't move the choice to its twin. */
export function resolveMic(choice: MicChoice | undefined, mics: Mic[]): MicChoice | undefined {
  if (!choice) return choice;
  const same = mics.find((m) => m.id === choice.id);
  // Picked before permission (no name then): take its real name now, so it can be followed later.
  if (same) return choice.label ? choice : { id: same.id, label: same.label };
  const named = choice.label ? mics.filter((m) => m.label === choice.label) : [];
  return named.length === 1 ? { id: named[0].id, label: named[0].label } : choice;
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
