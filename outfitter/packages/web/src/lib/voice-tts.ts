// #255 spoken replies: the two ways a reply is read aloud, behind one interface.
// - "deepgram" (default): Aura over wss://api.deepgram.com/v1/speak with a 30 s token from
//   POST /api/voice/token (bearer subprotocol, tagged per person so TTS counts toward spend).
//   Sentences go in as Speak messages, then Flush; linear16 PCM comes back and is scheduled
//   gaplessly on an AudioContext, so the first sentence plays while the rest are synthesized.
// - "builtin": the browser's speechSynthesis, one utterance per sentence.
// Every browser API comes in through deps, so the tests drive both with fakes.

export type SpeechOutcome = "done" | "stopped" | "error";

export interface Speech {
  /** Resolves when the last sentence has finished playing, or it was stopped or failed. */
  done: Promise<SpeechOutcome>;
  /** Stops at once: no more audio. */
  stop(): void;
}

export interface SpeakToken {
  token: string;
  tag: string;
}

export interface DeepgramSpeechDeps {
  getToken(): Promise<SpeakToken>;
  WebSocket: typeof WebSocket;
  /** Created in a user gesture (browsers block audio otherwise) and reused. */
  audio: AudioContext;
  /** How long to wait for the socket to open before giving up. */
  openTimeoutMs?: number;
}

const SPEAK_URL = "wss://api.deepgram.com/v1/speak";
const SAMPLE_RATE = 24_000;

export function speakUrl(voice: string, tag: string): string {
  const params = new URLSearchParams({ model: voice, encoding: "linear16", sample_rate: String(SAMPLE_RATE), tag });
  return `${SPEAK_URL}?${params}`;
}

/** 16-bit little-endian PCM → floats in [-1, 1]. */
export function pcm16ToFloat(bytes: ArrayBuffer): Float32Array {
  const view = new DataView(bytes);
  const out = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

export function speakDeepgram(sentences: string[], voice: string, deps: DeepgramSpeechDeps): Speech {
  let stopped = false;
  let ws: WebSocket | undefined;
  const sources: AudioBufferSourceNode[] = [];
  let nextAt = 0;
  let finish!: (o: SpeechOutcome) => void;
  const done = new Promise<SpeechOutcome>((r) => (finish = r));
  let settled = false;
  const settle = (o: SpeechOutcome) => {
    if (settled) return;
    settled = true;
    finish(o);
  };
  // PCM can arrive split mid-sample; carry the odd byte to the next frame.
  let leftover: Uint8Array | undefined;

  function play(bytes: ArrayBuffer) {
    let buf = new Uint8Array(bytes);
    if (leftover) {
      const joined = new Uint8Array(leftover.length + buf.length);
      joined.set(leftover);
      joined.set(buf, leftover.length);
      buf = joined;
      leftover = undefined;
    }
    if (buf.length % 2) {
      leftover = buf.slice(buf.length - 1);
      buf = buf.slice(0, buf.length - 1);
    }
    if (buf.length === 0) return;
    const samples = pcm16ToFloat(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const ctx = deps.audio;
    const audioBuf = ctx.createBuffer(1, samples.length, SAMPLE_RATE);
    audioBuf.getChannelData(0).set(samples);
    const src = ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(ctx.destination);
    nextAt = Math.max(nextAt, ctx.currentTime);
    src.start(nextAt);
    nextAt += audioBuf.duration;
    sources.push(src);
  }

  function endWhenPlayed() {
    const last = sources[sources.length - 1];
    if (!last) return settle("done");
    last.onended = () => settle(stopped ? "stopped" : "done");
  }

  (async () => {
    let token: SpeakToken;
    try {
      token = await deps.getToken();
    } catch {
      return settle("error");
    }
    if (stopped) return settle("stopped");
    const socket = new deps.WebSocket(speakUrl(voice, token.tag), ["bearer", token.token]);
    ws = socket;
    socket.binaryType = "arraybuffer";
    const openTimer = setTimeout(() => {
      if (socket.readyState !== deps.WebSocket.OPEN) {
        socket.close();
        settle("error");
      }
    }, deps.openTimeoutMs ?? 8000);
    socket.onopen = () => {
      clearTimeout(openTimer);
      for (const text of sentences) socket.send(JSON.stringify({ type: "Speak", text }));
      socket.send(JSON.stringify({ type: "Flush" }));
    };
    socket.onmessage = (e: MessageEvent) => {
      if (stopped) return;
      if (typeof e.data === "string") {
        let msg: { type?: string };
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.type === "Flushed") {
          // All audio is in; let it play out.
          socket.send(JSON.stringify({ type: "Close" }));
          endWhenPlayed();
        }
        return;
      }
      play(e.data as ArrayBuffer);
    };
    socket.onclose = () => {
      clearTimeout(openTimer);
      if (stopped) return settle("stopped");
      // Closed before Flushed: play whatever arrived, then call it an error only if nothing did.
      if (!settled && sources.length === 0) settle("error");
      else endWhenPlayed();
    };
  })();

  return {
    done,
    stop() {
      if (stopped) return;
      stopped = true;
      ws?.close();
      for (const s of sources) {
        try {
          s.stop();
        } catch {
          // not started yet, or already ended
        }
      }
      settle("stopped");
    },
  };
}

export interface BuiltinSpeechDeps {
  synth: Pick<SpeechSynthesis, "speak" | "cancel">;
  Utterance: typeof SpeechSynthesisUtterance;
  lang: string;
}

export function speakBuiltin(sentences: string[], deps: BuiltinSpeechDeps): Speech {
  let stopped = false;
  let finish!: (o: SpeechOutcome) => void;
  const done = new Promise<SpeechOutcome>((r) => (finish = r));
  if (sentences.length === 0) finish("done");
  sentences.forEach((text, i) => {
    const u = new deps.Utterance(text);
    u.lang = deps.lang;
    if (i === sentences.length - 1) u.onend = () => finish(stopped ? "stopped" : "done");
    u.onerror = (e: SpeechSynthesisErrorEvent) => finish(e.error === "interrupted" || e.error === "canceled" || stopped ? "stopped" : "error");
    deps.synth.speak(u);
  });
  return {
    done,
    stop() {
      stopped = true;
      deps.synth.cancel();
      finish("stopped");
    },
  };
}
