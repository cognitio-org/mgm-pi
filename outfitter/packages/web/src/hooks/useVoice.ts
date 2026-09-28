// Web voice (#253, epic #256): the Composer's mic. Owns the gesture (voice-gesture.ts), the
// recording (voice-engines.ts), the draft while speaking, and the two settings: the floppy's
// engine (PUT /api/sessions/:id/voice) and the person's "after speaking" (PUT /api/me/voice).

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type VoiceConfig } from "../api/client.ts";
import { composeDraft, IDLE, stepGesture, type GestureEvent, type GestureState } from "../lib/voice-gesture.ts";
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

export type EngineStarter = (callbacks: VoiceCallbacks) => Promise<VoiceRecording>;

export interface VoiceEngines {
  deepgram: EngineStarter;
  builtin: EngineStarter;
  /** Whether the built-in engine exists in this browser. */
  builtinAvailable: boolean;
}

/** Production engines: real browser APIs, tokens from the API. */
export function browserEngines(language = navigator.language || "en"): VoiceEngines {
  const Recognition = builtinRecognition();
  return {
    deepgram: (callbacks) =>
      startDeepgram(callbacks, {
        getToken: async () => {
          try {
            return await api.voiceToken();
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) throw new VoiceError("disabled", "Deepgram voice is off here");
            if (err instanceof ApiError && err.status === 429) throw new VoiceError("rate-limited", "Too many voice requests; try again in a minute");
            throw new VoiceError("upstream", "Couldn't get a Deepgram token");
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
  level: number;
  /** A one-line note for the person: an error, or why the engine switched. */
  note: string | null;
  engine: VoiceEngineName;
  setEngine(engine: VoiceEngineName): void;
  afterSpeaking: AfterSpeaking;
  setAfterSpeaking(value: AfterSpeaking): void;
  /** False until GET /api/me/voice answers, then whether Deepgram works here. */
  deepgramAvailable: boolean;
  builtinAvailable: boolean;
  /** Whether the mic can be used at all (some engine is available, the composer isn't disabled). */
  usable: boolean;
  press(): void;
  release(): void;
  cancel(): void;
}

const ERROR_NOTES: Record<VoiceError["kind"], string> = {
  permission: "Microphone access was refused. Allow it in the browser's site settings.",
  "no-mic": "No microphone found.",
  unsupported: "This browser can't do voice input.",
  disabled: "Deepgram voice is off here.",
  "rate-limited": "Too many voice requests; try again in a minute.",
  network: "The connection dropped. What was heard is in the box; it wasn't sent.",
  upstream: "Deepgram didn't answer.",
};

/** Deepgram failures the built-in engine can stand in for (#251: "offered automatically"). */
const FALLBACK_KINDS = new Set<VoiceError["kind"]>(["disabled", "rate-limited", "upstream"]);

export function useVoice(opts: UseVoiceOptions): Voice {
  const [engines] = useState<VoiceEngines>(() => opts.engines ?? browserEngines());
  const now = opts.now ?? Date.now;
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const [latched, setLatched] = useState(false);
  const [level, setLevel] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [engine, setEngineState] = useState<VoiceEngineName>(opts.initialEngine ?? "deepgram");
  const [afterSpeaking, setAfterSpeakingState] = useState<AfterSpeaking>("send");
  const [deepgramAvailable, setDeepgramAvailable] = useState(false);

  const gesture = useRef<GestureState>(IDLE);
  const recording = useRef<VoiceRecording | null>(null);
  const base = useRef("");
  // A stop that arrived while the engine was still starting (a very short hold).
  const stopWhenStarted = useRef(false);
  const cancelled = useRef(false);
  // From a start until the recording is fully done (including "finishing"): a new press then is
  // ignored, or its recording would replace this one and lose its transcript.
  const busy = useRef(false);
  // Latest values for callbacks that outlive a render.
  const live = useRef({ opts, afterSpeaking, engine, deepgramAvailable });
  live.current = { opts, afterSpeaking, engine, deepgramAvailable };

  useEffect(() => {
    let gone = false;
    api
      .voiceConfig()
      .then((cfg) => {
        if (gone) return;
        setDeepgramAvailable(cfg.deepgram);
        setAfterSpeakingState(cfg.prefs.afterSpeaking);
      })
      .catch(() => {
        if (!gone) setDeepgramAvailable(false);
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
      recording.current?.cancel();
      recording.current = null;
    },
    [],
  );

  const reset = useCallback(() => {
    busy.current = false;
    gesture.current = IDLE;
    recording.current = null;
    stopWhenStarted.current = false;
    setLatched(false);
    setLevel(0);
    setStatus("idle");
  }, []);

  const callbacks: VoiceCallbacks = {
    onTranscript: (text) => live.current.opts.setDraft(composeDraft(base.current, text)),
    onLevel: setLevel,
    onError: (err) => {
      // Mid-recording failure (the connection dropped): keep what was heard, never send it.
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
    if (after === "send" && result.transcript.trim() && !o.disabled) await o.send(draft);
  }, [reset]);

  const begin = useCallback(async () => {
    const { opts: o, engine: chosen, deepgramAvailable: dg } = live.current;
    setNote(null);
    busy.current = true;
    cancelled.current = false;
    base.current = o.getDraft();
    setStatus("starting");
    const first: VoiceEngineName = chosen === "deepgram" && !dg && engines.builtinAvailable ? "builtin" : chosen;
    let rec: VoiceRecording;
    try {
      rec = await engines[first](callbacks);
    } catch (err) {
      const e = err instanceof VoiceError ? err : new VoiceError("upstream", String(err));
      if (first === "deepgram" && FALLBACK_KINDS.has(e.kind) && engines.builtinAvailable && !cancelled.current) {
        try {
          rec = await engines.builtin(callbacks);
          setNote(`${ERROR_NOTES[e.kind]} Using the browser's built-in speech instead.`);
        } catch (err2) {
          setNote(ERROR_NOTES[err2 instanceof VoiceError ? err2.kind : "upstream"]);
          reset();
          return;
        }
      } else {
        setNote(ERROR_NOTES[e.kind]);
        reset();
        return;
      }
    }
    if (cancelled.current) {
      rec.cancel();
      busy.current = false;
      return;
    }
    recording.current = rec;
    setStatus("recording");
    if (stopWhenStarted.current) {
      stopWhenStarted.current = false;
      await finish();
    }
  }, [engines, finish, reset]);

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
        cancelled.current = true;
        recording.current?.cancel();
        live.current.opts.setDraft(base.current);
        reset();
      }
    },
    [begin, finish, reset],
  );

  const usable = !opts.disabled && (deepgramAvailable || engines.builtinAvailable);

  return {
    status,
    latched,
    level,
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
    usable,
    press() {
      if (gesture.current.kind === "idle" && (!usable || busy.current)) return;
      dispatch({ type: "press", at: now() });
    },
    release() {
      dispatch({ type: "release", at: now() });
    },
    cancel() {
      dispatch({ type: "cancel" });
    },
  };
}
