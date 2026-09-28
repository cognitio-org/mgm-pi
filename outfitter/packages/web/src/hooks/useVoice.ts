// Web voice (#253, epic #256): the Composer's mic. Owns the gesture (voice-gesture.ts), the
// recording (voice-engines.ts), the draft while speaking, and the two settings: the floppy's
// engine (PUT /api/sessions/:id/voice) and the person's "after speaking" (PUT /api/me/voice).

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { api, ApiError, type VoiceConfig } from "../api/client.ts";
import { DEFAULT_TTS_VOICE } from "../lib/tts-voices.ts";
import { composeDraft, IDLE, stepGesture, type GestureEvent, type GestureState } from "../lib/voice-gesture.ts";
import { listMics, loadMicChoice, resolveMic, saveMicChoice, type Mic, type MicChoice } from "../lib/voice-mic.ts";
import {
  builtinRecognition,
  startBuiltin,
  startDeepgram,
  VoiceError,
  type VoiceCallbacks,
  type VoiceEngineName,
  type VoiceRecording,
} from "../lib/voice-engines.ts";

export type VoiceStatus = "idle" | "starting" | "recording" | "finishing";
export type AfterSpeaking = VoiceConfig["prefs"]["afterSpeaking"];

/** `deviceId`: the chosen microphone (#267); only the Deepgram engine can use it. */
export type EngineStarter = (callbacks: VoiceCallbacks, opts?: { deviceId?: string }) => Promise<VoiceRecording>;

export interface VoiceEngines {
  deepgram: EngineStarter;
  builtin: EngineStarter;
  /** Whether the built-in engine exists in this browser. */
  builtinAvailable: boolean;
}

/** What a failed POST /api/voice/token means for the mic. */
export function voiceTokenError(err: unknown): VoiceError {
  if (err instanceof ApiError && err.status === 404) return new VoiceError("disabled", "Deepgram voice is off here");
  if (err instanceof ApiError && err.status === 429) return new VoiceError("rate-limited", "Too many voice requests; try again in a minute");
  if (err instanceof ApiError && err.status === 403) return new VoiceError("cap-reached", "This month's Deepgram voice cap is reached");
  return new VoiceError("upstream", "Couldn't get a Deepgram token");
}

/** Production engines: real browser APIs, tokens from the API. */
export function browserEngines(language = navigator.language || "en"): VoiceEngines {
  const Recognition = builtinRecognition();
  return {
    deepgram: (callbacks, opts) =>
      startDeepgram(callbacks, {
        deviceId: opts?.deviceId,
        getToken: async () => {
          try {
            return await api.voiceToken();
          } catch (err) {
            throw voiceTokenError(err);
          }
        },
        getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
        MediaRecorder: window.MediaRecorder,
        WebSocket: window.WebSocket,
        AudioContext: window.AudioContext,
      }),
    builtin: (callbacks) => startBuiltin(callbacks, { Recognition, language }),
    builtinAvailable: !!Recognition,
  };
}

export interface UseVoiceOptions {
  sessionId: string;
  initialEngine?: VoiceEngineName;
  disabled?: boolean;
  /** The draft as it is now, and a way to replace it. */
  getDraft(): string;
  setDraft(text: string): void;
  /** Sends a finished transcript (after speaking = send). */
  send(text: string): Promise<void>;
  engines?: VoiceEngines;
  now?: () => number;
}

export interface Voice {
  status: VoiceStatus;
  /** A tap latched the mic on (aria-pressed stays true between presses). */
  latched: boolean;
  /** The element whose `--voice-level` (0..1) the level meter writes, without re-rendering. */
  levelTarget: RefObject<HTMLElement | null>;
  /** A one-line note for the person: an error, or why the engine switched. */
  note: string | null;
  engine: VoiceEngineName;
  setEngine(engine: VoiceEngineName): void;
  afterSpeaking: AfterSpeaking;
  setAfterSpeaking(value: AfterSpeaking): void;
  /** False until GET /api/me/voice answers, then whether Deepgram works here. */
  deepgramAvailable: boolean;
  builtinAvailable: boolean;
  /** #267: the microphones the browser offers, the chosen one (undefined: system default), and
   * whether their names are visible yet (only after mic permission has been granted once). */
  mics: Mic[];
  micsLabelled: boolean;
  /** Whether this page can list and open microphones at all (not on plain http, for instance). */
  micsAvailable: boolean;
  micId: string | undefined;
  setMicId(id: string | undefined): void;
  refreshMics(): void;
  /** Asks for mic permission once, so the list shows real names. */
  allowMicList(): void;
  /** Whether the mic can be used at all (some engine is available, the composer isn't disabled). */
  usable: boolean;
  press(): void;
  release(): void;
  cancel(): void;
  /** #255: the Aura voice replies are read in, and hands-free (see HANDS_FREE_*). */
  ttsVoice: string;
  setTtsVoice(voice: string): void;
  handsFree: boolean;
  setHandsFree(on: boolean): void;
  /** Hands-free is on but waiting: Esc, or the reopened mic heard nothing. The next press resumes. */
  handsFreePaused: boolean;
  /** Hands-free: reopen the mic (latched) for the next turn. No-op unless it's idle and not paused. */
  openHandsFree(): void;
}

/** Hands-free: this long without a new word, after something was said, ends the turn and sends. */
export const HANDS_FREE_SILENCE_MS = 1_500;
/** Hands-free: a reopened mic that hears nothing for this long closes and pauses the loop, rather
 * than streaming (and billing) silence. */
export const HANDS_FREE_NO_SPEECH_MS = 8_000;

const ERROR_NOTES: Record<VoiceError["kind"], string> = {
  permission: "Microphone access was refused. Allow it in the browser's site settings.",
  "no-mic": "No microphone found.",
  unsupported: "This browser can't do voice input.",
  disabled: "Deepgram voice is off here.",
  "rate-limited": "Too many voice requests; try again in a minute.",
  "cap-reached": "You've reached this month's Deepgram voice cap.",
  network: "The connection dropped. What was heard is in the box; it wasn't sent.",
  upstream: "Deepgram didn't answer.",
};

/** Deepgram failures the built-in engine can stand in for (#251: "offered automatically"). */
const FALLBACK_KINDS = new Set<VoiceError["kind"]>(["disabled", "rate-limited", "cap-reached", "upstream"]);

export function useVoice(opts: UseVoiceOptions): Voice {
  const [engines] = useState<VoiceEngines>(() => opts.engines ?? browserEngines());
  const now = opts.now ?? Date.now;
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [latched, setLatched] = useState(false);
  const levelTarget = useRef<HTMLElement | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [engine, setEngineState] = useState<VoiceEngineName>(opts.initialEngine ?? "deepgram");
  const [afterSpeaking, setAfterSpeakingState] = useState<AfterSpeaking>("send");
  const [ttsVoice, setTtsVoiceState] = useState(DEFAULT_TTS_VOICE);
  const [handsFree, setHandsFreeState] = useState(false);
  const [handsFreePaused, setHandsFreePaused] = useState(false);
  // Hands-free turn-taking: when words last arrived, whether any have, when this recording began,
  // and whether hands-free opened it (only then does the no-speech timeout apply).
  const heardAt = useRef(0);
  const heard = useRef(false);
  const startedAt = useRef(0);
  const autoOpened = useRef(false);
  const autoNext = useRef(false);
  const lastHeard = useRef("");
  const [deepgramAvailable, setDeepgramAvailable] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [mics, setMics] = useState<Mic[]>([]);
  const [micsLabelled, setMicsLabelled] = useState(false);
  const [micChoice, setMicChoice] = useState<MicChoice | undefined>(() => loadMicChoice());
  // navigator.mediaDevices is one object for the page's life, so this is stable.
  const [devices] = useState(() => (typeof navigator === "undefined" ? undefined : navigator.mediaDevices));
  const micId = micChoice?.id;
  const resolvedByName = useRef(false);

  const gesture = useRef<GestureState>(IDLE);
  const recording = useRef<VoiceRecording | null>(null);
  const base = useRef("");
  // A stop that arrived while the engine was still starting (a very short hold).
  const stopWhenStarted = useRef(false);
  // Each start gets a number; cancelling, a mid-start error, or unmounting bumps it, and a start
  // that finds its number stale when the engine resolves cancels what it got. Otherwise a
  // recording that finished starting after the person gave up would stream on with no UI.
  const attempt = useRef(0);
  const disposed = useRef(false);
  // From a start until the recording is fully done (including "finishing"): a new press then is
  // ignored, or its recording would replace this one and lose its transcript.
  const busy = useRef(false);
  // Latest values for callbacks that outlive a render.
  const live = useRef({ opts, afterSpeaking, engine, deepgramAvailable, configLoaded, micId, handsFree });
  live.current = { opts, afterSpeaking, engine, deepgramAvailable, configLoaded, micId, handsFree };

  const refreshMics = useCallback(() => {
    listMics(devices)
      .then(({ mics: found, labelled }) => {
        setMics(found);
        setMicsLabelled(labelled);
        // The same mic under a new id (a private window, cleared site data): follow it by name. Only
        // on the page's first named listing: ids change between sessions, not while a page is open,
        // so a mic unplugged mid-session stays the choice (shown "not connected") rather than
        // passing to a same-named twin.
        if (labelled && !resolvedByName.current) {
          resolvedByName.current = true;
          setMicChoice((current) => resolveMic(current, found));
        }
      })
      .catch(() => {});
  }, [devices]);

  // One place writes the choice to storage, whatever changed it.
  useEffect(() => saveMicChoice(micChoice), [micChoice]);

  // The list follows headsets and USB mics coming and going.
  useEffect(() => {
    refreshMics();
    devices?.addEventListener?.("devicechange", refreshMics);
    return () => devices?.removeEventListener?.("devicechange", refreshMics);
  }, [devices, refreshMics]);

  useEffect(() => {
    let gone = false;
    api
      .voiceConfig()
      .then((cfg) => {
        if (gone) return;
        setDeepgramAvailable(cfg.deepgram);
        setAfterSpeakingState(cfg.prefs.afterSpeaking);
        if (cfg.prefs.ttsVoice) setTtsVoiceState(cfg.prefs.ttsVoice);
        setHandsFreeState(cfg.prefs.handsFree === true);
        setConfigLoaded(true);
      })
      .catch(() => {
        if (gone) return;
        setDeepgramAvailable(false);
        setConfigLoaded(true);
      });
    return () => {
      gone = true;
    };
  }, []);

  useEffect(() => {
    if (opts.initialEngine) setEngineState(opts.initialEngine);
  }, [opts.initialEngine]);

  // Leaving the page mid-recording must not leave the mic on.
  useEffect(
    () => () => {
      disposed.current = true;
      attempt.current++;
      recording.current?.cancel();
      recording.current = null;
    },
    [],
  );

  const setLevel = useCallback((value: number) => {
    levelTarget.current?.style.setProperty("--voice-level", String(value));
  }, []);

  const reset = useCallback(() => {
    busy.current = false;
    gesture.current = IDLE;
    recording.current = null;
    stopWhenStarted.current = false;
    setLatched(false);
    setLevel(0);
    setStatus("idle");
  }, [setLevel]);

  const callbacks: VoiceCallbacks = {
    onTranscript: (text) => {
      // Only new words count: Deepgram keeps sending results through a silence, each repeating
      // the transcript so far, and those mustn't hold hands-free's pause open.
      if (text.trim() && text !== lastHeard.current) {
        heard.current = true;
        heardAt.current = now();
      }
      lastHeard.current = text;
      live.current.opts.setDraft(composeDraft(base.current, text));
    },
    onLevel: setLevel,
    onDeviceFallback: () => setNote("Your chosen microphone isn't connected, so the default one is recording."),
    onError: (err) => {
      // Mid-recording failure (the connection dropped): keep what was heard, never send it. A
      // start still in flight is stale now and cancels what it gets.
      attempt.current++;
      recording.current?.cancel();
      setNote(ERROR_NOTES[err.kind]);
      reset();
    },
  };

  const finish = useCallback(async () => {
    const rec = recording.current;
    if (!rec) return;
    setStatus("finishing");
    setLatched(false);
    const result = await rec.stop();
    if (recording.current !== rec) return; // cancelled or replaced meanwhile
    reset();
    const { opts: o, afterSpeaking: after } = live.current;
    const draft = composeDraft(base.current, result.transcript);
    o.setDraft(draft);
    if (!result.complete) {
      setNote(ERROR_NOTES.network);
      return;
    }
    // Hands-free always sends: that's the loop.
    if ((after === "send" || live.current.handsFree) && result.transcript.trim() && !o.disabled) await o.send(draft);
  }, [reset]);

  /** Which engine to try first. The floppy's choice, unless it can't work here: Deepgram off (once
   * the server has said so) means built-in, and built-in missing from this browser means Deepgram. */
  function firstEngine(): VoiceEngineName {
    const { engine: chosen, deepgramAvailable: dg, configLoaded: loaded } = live.current;
    if (chosen === "deepgram" && loaded && !dg && engines.builtinAvailable) return "builtin";
    if (chosen === "builtin" && !engines.builtinAvailable) return "deepgram";
    return chosen;
  }

  const begin = useCallback(async () => {
    const id = ++attempt.current;
    const stale = () => attempt.current !== id || disposed.current;
    const o = live.current.opts;
    setNote(null);
    busy.current = true;
    heard.current = false;
    lastHeard.current = "";
    startedAt.current = now();
    autoOpened.current = autoNext.current;
    autoNext.current = false;
    base.current = o.getDraft();
    setStatus("starting");
    const first = firstEngine();
    let rec: VoiceRecording;
    try {
      rec = await engines[first](callbacks, { deviceId: live.current.micId });
    } catch (err) {
      if (stale()) return;
      const e = err instanceof VoiceError ? err : new VoiceError("upstream", String(err));
      if (!(first === "deepgram" && FALLBACK_KINDS.has(e.kind) && engines.builtinAvailable)) {
        setNote(ERROR_NOTES[e.kind]);
        reset();
        return;
      }
      try {
        rec = await engines.builtin(callbacks);
      } catch (err2) {
        if (stale()) return;
        setNote(ERROR_NOTES[err2 instanceof VoiceError ? err2.kind : "upstream"]);
        reset();
        return;
      }
      if (!stale()) setNote(`${ERROR_NOTES[e.kind]} Using the browser's built-in speech instead.`);
    }
    if (stale()) {
      rec.cancel();
      return;
    }
    recording.current = rec;
    setStatus("recording");
    if (stopWhenStarted.current) {
      stopWhenStarted.current = false;
      await finish();
    }
  }, [engines, finish, reset]);

  /** Esc: throw away what's being heard and put the draft back, whatever state the mic is in,
   * including "finishing" (the person may be stopping an auto-send). */
  const abort = useCallback(() => {
    attempt.current++;
    const rec = recording.current;
    recording.current = null; // finish() sees this and doesn't apply or send its result
    rec?.cancel();
    live.current.opts.setDraft(base.current);
    reset();
  }, [reset]);

  const dispatch = useCallback(
    (event: GestureEvent) => {
      const { state, action } = stepGesture(gesture.current, event);
      gesture.current = state;
      setLatched(state.kind === "latched");
      if (action === "start") void begin();
      else if (action === "stop") {
        if (recording.current) void finish();
        else stopWhenStarted.current = true;
      } else if (action === "cancel") {
        abort();
      }
    },
    [begin, finish, abort],
  );

  const usable = !opts.disabled && (deepgramAvailable || engines.builtinAvailable);

  /** Ends the recording as if it were released: its transcript goes the usual way. */
  const stopNow = useCallback(() => {
    gesture.current = IDLE;
    setLatched(false);
    if (recording.current) void finish();
    else stopWhenStarted.current = true;
  }, [finish]);

  // Hands-free turn-taking while recording: a pause after speaking sends; a reopened mic that hears
  // nothing closes and pauses the loop.
  useEffect(() => {
    if (status !== "recording" || !handsFree) return;
    const timer = setInterval(() => {
      const t = now();
      // Only a latched recording (hands-free's own, or a tap): a hold ends when you let go, and
      // pausing mid-hold to think mustn't send it.
      if (heard.current && gesture.current.kind === "latched" && t - heardAt.current >= HANDS_FREE_SILENCE_MS) {
        clearInterval(timer);
        stopNow();
      } else if (!heard.current && autoOpened.current && t - startedAt.current >= HANDS_FREE_NO_SPEECH_MS) {
        clearInterval(timer);
        abort();
        setHandsFreePaused(true);
        setNote("Hands-free paused: nothing heard. Press the mic to go on.");
      }
    }, 250);
    return () => clearInterval(timer);
  }, [status, handsFree, stopNow, abort]);

  return {
    status,
    latched,
    levelTarget,
    note,
    engine,
    setEngine(next) {
      const prev = live.current.engine;
      setEngineState(next);
      api.setSessionVoiceEngine(opts.sessionId, next).catch(() => {
        setEngineState(prev);
        setNote("Couldn't save the engine choice.");
      });
    },
    afterSpeaking,
    setAfterSpeaking(next) {
      const prev = live.current.afterSpeaking;
      setAfterSpeakingState(next);
      api.setVoicePrefs({ afterSpeaking: next }).catch(() => {
        setAfterSpeakingState(prev);
        setNote("Couldn't save that setting.");
      });
    },
    deepgramAvailable,
    builtinAvailable: engines.builtinAvailable,
    mics,
    micsLabelled,
    micsAvailable: !!devices?.enumerateDevices,
    micId,
    setMicId(id) {
      // Before permission the names are placeholders ("Microphone 2"); only a real one is kept.
      const choice = id ? { id, label: micsLabelled ? mics.find((m) => m.id === id)?.label : undefined } : undefined;
      setMicChoice(choice);
    },
    refreshMics,
    allowMicList() {
      devices
        ?.getUserMedia({ audio: true })
        .then((stream) => {
          stream.getTracks().forEach((t) => t.stop());
          refreshMics();
        })
        .catch((err) =>
          setNote((err as { name?: string })?.name === "NotFoundError" ? ERROR_NOTES["no-mic"] : ERROR_NOTES.permission),
        );
    },
    usable,
    ttsVoice,
    setTtsVoice(next) {
      const prev = ttsVoice;
      setTtsVoiceState(next);
      api.setVoicePrefs({ ttsVoice: next }).catch(() => {
        setTtsVoiceState(prev);
        setNote("Couldn't save the reply voice.");
      });
    },
    handsFree,
    setHandsFree(on) {
      const prev = handsFree;
      setHandsFreeState(on);
      setHandsFreePaused(false);
      api.setVoicePrefs({ handsFree: on }).catch(() => {
        setHandsFreeState(prev);
        setNote("Couldn't save hands-free.");
      });
    },
    handsFreePaused,
    openHandsFree() {
      if (!live.current.handsFree || handsFreePaused || !usable || busy.current || gesture.current.kind !== "idle") return;
      autoNext.current = true;
      gesture.current = { kind: "latched" };
      setLatched(true);
      void begin();
    },
    press() {
      if (gesture.current.kind === "idle" && (!usable || busy.current)) return;
      setHandsFreePaused(false); // a press of your own picks the loop back up
      dispatch({ type: "press", at: now() });
    },
    release() {
      dispatch({ type: "release", at: now() });
    },
    cancel() {
      if (live.current.handsFree) setHandsFreePaused(true); // Esc steps out of the loop
      // Finishing: the gesture is already over (or only its stopping press is down), so it has
      // nothing to cancel; the recording still does.
      if (busy.current && (gesture.current.kind === "idle" || gesture.current.kind === "stopping")) abort();
      else dispatch({ type: "cancel" });
    },
  };
}
