// #255 spoken replies: reads new assistant replies aloud on the session page. Only replies that
// arrive while the speaker is on (never the history already on the page), with code, links and
// markdown left out (lib/speech-text.ts). The mic comes first: nothing is spoken while it's live,
// and the mic going live stops what's playing. With hands-free on, once the agent's turn is over and
// everything has been read, onTurnSpoken tells the mic to reopen.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type PiEntry } from "../api/client.ts";
import { prepareForSpeech, replyText, splitSentences } from "../lib/speech-text.ts";
import { speakBuiltin, speakDeepgram, type Speech } from "../lib/voice-tts.ts";
import { isFinalAssistant } from "../lib/send-status.ts";
import { hiddenEntryIds } from "../lib/entry-view.ts";

export type SpeakEngine = "deepgram" | "builtin";

/** Starts reading sentences; the tests pass fakes. */
export type SpeechStarter = (sentences: string[], engine: SpeakEngine, voice: string) => Speech;

export interface UseSpeakerOptions {
  sessionId: string;
  entries: PiEntry[];
  /** The page has its history. Entries before that are history, not new replies, however they
   * arrive (the first render has none; the history lands a moment later). */
  entriesLoaded: boolean;
  initialOn?: boolean;
  /** Which engine to read with: the floppy's, unless it can't work here. */
  engine: SpeakEngine;
  voice: string;
  /** The mic is recording (or starting/finishing): don't speak, and stop speaking. */
  micBusy: boolean;
  /** The agent is still on its turn (sending, waking, working). */
  agentBusy: boolean;
  /** Called when a finished turn has been read out and the agent is idle (hands-free reopens). */
  onTurnSpoken?(): void;
  start?: SpeechStarter;
}

export interface Speaker {
  on: boolean;
  setOn(on: boolean): void;
  speaking: boolean;
  stop(): void;
  note: string | null;
}

let sharedAudio: AudioContext | undefined;

/** One AudioContext for the page, made (and resumed) inside a click: browsers block audio that
 * no gesture allowed. */
export function unlockAudio(): AudioContext | undefined {
  if (typeof window === "undefined" || !window.AudioContext) return undefined;
  sharedAudio ??= new window.AudioContext();
  void sharedAudio.resume().catch(() => {});
  return sharedAudio;
}

/** Production: Deepgram Aura over its WebSocket, or the browser's speechSynthesis. */
export const browserSpeech: SpeechStarter = (sentences, engine, voice) => {
  const audio = engine === "deepgram" ? (sharedAudio ?? unlockAudio()) : undefined;
  if (!audio) {
    return speakBuiltin(sentences, { synth: window.speechSynthesis, Utterance: window.SpeechSynthesisUtterance, lang: navigator.language || "en" });
  }
  return speakDeepgram(sentences, voice, {
    getToken: async () => {
      try {
        const t = await api.voiceToken();
        return { token: t.token, tag: t.tag };
      } catch (err) {
        throw err instanceof ApiError ? err : new Error(String(err));
      }
    },
    WebSocket: window.WebSocket,
    audio,
  });
};

export function useSpeaker(opts: UseSpeakerOptions): Speaker {
  const start = opts.start ?? browserSpeech;
  const [on, setOnState] = useState(opts.initialOn === true);
  const [speaking, setSpeaking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // Entry ids already on the page: never read out, even when the speaker is turned on later.
  const seen = useRef<Set<string> | null>(null);
  const queue = useRef<string[][]>([]);
  const current = useRef<Speech | null>(null);
  // A reply arrived this turn (read or not: all code, tool calls only, the speaker off). Once the
  // agent is idle and nothing is left to read, it's the person's turn again.
  const replyThisTurn = useRef(false);
  const disposed = useRef(false);
  const live = useRef(opts);
  live.current = opts;

  useEffect(() => {
    if (opts.initialOn !== undefined) setOnState(opts.initialOn);
  }, [opts.initialOn]);

  const stop = useCallback(() => {
    queue.current = [];
    current.current?.stop();
    current.current = null;
    setSpeaking(false);
  }, []);

  const maybeTurnSpoken = useCallback(() => {
    const o = live.current;
    if (disposed.current) return;
    if (replyThisTurn.current && !current.current && queue.current.length === 0 && !o.agentBusy && !o.micBusy) {
      replyThisTurn.current = false;
      o.onTurnSpoken?.();
    }
  }, []);

  const playNext = useCallback(() => {
    if (disposed.current || current.current || live.current.micBusy) return;
    const next = queue.current.shift();
    if (!next) {
      setSpeaking(false);
      maybeTurnSpoken();
      return;
    }
    const o = live.current;
    const speech = start(next, o.engine, o.voice);
    current.current = speech;
    setSpeaking(true);
    void speech.done.then((outcome) => {
      if (current.current !== speech) return; // stopped and replaced
      current.current = null;
      if (outcome === "error") setNote("Couldn't read the reply aloud.");
      playNext();
    });
  }, [start, maybeTurnSpoken]);

  // New replies: read the ones that arrived after the page had its history, while the speaker is on.
  useEffect(() => {
    // Not loaded (a fresh page, or this floppy's history is being fetched after a switch): forget
    // what was seen, so whatever is on the page once it has loaded counts as history.
    if (!opts.entriesLoaded) {
      seen.current = null;
      return;
    }
    if (!seen.current) {
      seen.current = new Set(opts.entries.map((e) => e.id));
      return;
    }
    const hidden = hiddenEntryIds(opts.entries);
    for (const entry of opts.entries) {
      if (seen.current.has(entry.id)) continue;
      // #278: a failed attempt may be retried, and pi says so (a context_edit) only after the message
      // lands. Decide once the agent isn't busy; until then leave it unseen. It is never read aloud:
      // its prose is a half-written reply the retry usually repeats.
      const failed = isAssistant(entry) && (entry.message as { stopReason?: string }).stopReason === "error";
      if (failed && opts.agentBusy) continue;
      seen.current.add(entry.id);
      if (!isAssistant(entry)) continue;
      // Only the turn's final reply hands the turn back (the status line's own test: not one that
      // stopped to call tools, is still streaming, or was hidden for a retry; an aborted or errored
      // reply otherwise does count).
      if (isFinalAssistant(entry, { hidden })) replyThisTurn.current = true;
      if (!on || failed) continue;
      const text = replyText(entry);
      const sentences = splitSentences(prepareForSpeech(text));
      if (sentences.length > 0) queue.current.push(sentences);
    }
    playNext();
  }, [opts.entries, opts.entriesLoaded, opts.agentBusy, on, playNext]);

  // The mic comes first: going live stops speech, and it's the person's turn now, so replies from
  // before don't hand the turn back again when they finish. When it's done, anything queued plays.
  useEffect(() => {
    if (opts.micBusy) {
      replyThisTurn.current = false;
      stop();
    } else playNext();
  }, [opts.micBusy, stop, playNext]);

  // The agent finishing its turn may be the last thing hands-free was waiting for.
  useEffect(() => {
    if (!opts.agentBusy) maybeTurnSpoken();
  }, [opts.agentBusy, maybeTurnSpoken]);

  // Leaving the page (or switching floppy: the Composer is keyed by session): nothing more plays,
  // and hands-free doesn't reopen a mic nobody is looking at.
  useEffect(
    () => () => {
      disposed.current = true;
      queue.current = [];
      const speech = current.current;
      current.current = null;
      speech?.stop();
    },
    [],
  );

  // Speaker already on when the page loads (it's saved per floppy): the browser only lets audio
  // start after a click or key on the page, so the first one unlocks it.
  useEffect(() => {
    if (!on) return;
    const unlock = () => unlockAudio();
    document.addEventListener("pointerdown", unlock, { once: true, capture: true });
    document.addEventListener("keydown", unlock, { once: true, capture: true });
    return () => {
      document.removeEventListener("pointerdown", unlock, { capture: true });
      document.removeEventListener("keydown", unlock, { capture: true });
    };
  }, [on]);

  return {
    on,
    setOn(next) {
      if (next) unlockAudio(); // inside the click that turned it on
      else stop();
      setNote(null);
      setOnState(next);
      api.setSessionVoiceSpeak(opts.sessionId, next).catch(() => {
        setOnState(!next);
        setNote("Couldn't save the speaker setting.");
      });
    },
    speaking,
    stop,
    note,
  };
}

function isAssistant(entry: PiEntry): boolean {
  return entry.type === "message" && (entry.message as { role?: unknown } | undefined)?.role === "assistant";
}
