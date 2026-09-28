// Web voice (#253, epic #256): the two speech engines behind one interface. Chrome and Safari only.
// - "deepgram" (default): the mic streams straight from the browser to Deepgram nova-3, with a
//   30 s token from POST /api/voice/token (the key never reaches the browser). Tagged per person
//   for spend (#257).
// - "builtin": the browser's own SpeechRecognition (Chrome sends audio to Google, Safari to Apple);
//   free, and the fallback when Deepgram is off or refuses.
// Every browser API comes in through `deps`, so the tests drive both engines with fakes.

export type VoiceEngineName = "deepgram" | "builtin";

export type VoiceErrorKind =
  | "permission" // the person (or the browser) refused the mic
  | "no-mic"
  | "unsupported" // no MediaRecorder / SpeechRecognition here
  | "disabled" // the server has no Deepgram key
  | "rate-limited"
  | "cap-reached" // this month's Deepgram spend is at the cap (#257)
  | "network" // the connection dropped mid-recording
  | "upstream"; // Deepgram or the API refused

export class VoiceError extends Error {
  constructor(
    public kind: VoiceErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "VoiceError";
  }
}

export interface VoiceResult {
  transcript: string;
  /** False when the connection dropped before the last words were transcribed: never auto-send it. */
  complete: boolean;
}

export interface VoiceCallbacks {
  /** Everything heard so far, final and interim, as one string. */
  onTranscript(text: string): void;
  /** 0..1, a few times a second, for the level meter. Deepgram engine only. */
  onLevel?(level: number): void;
  /** Something went wrong after start() resolved (the connection dropped, the mic went away). */
  onError(error: VoiceError): void;
}

export interface VoiceRecording {
  /** Stops listening and resolves once the last words are in. */
  stop(): Promise<VoiceResult>;
  /** Stops at once and throws away what was heard. */
  cancel(): void;
}

export interface VoiceToken {
  token: string;
  model: string;
  language: string;
  tag: string;
}

export interface DeepgramDeps {
  getToken(): Promise<VoiceToken>;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  MediaRecorder: typeof MediaRecorder;
  WebSocket: typeof WebSocket;
  AudioContext?: typeof AudioContext;
  /** How long stop() waits for Deepgram's last results before giving up. */
  finishTimeoutMs?: number;
  /** How long start() waits for the socket to open. */
  openTimeoutMs?: number;
}

const LISTEN_URL = "wss://api.deepgram.com/v1/listen";
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];

/** The first container this browser can record: webm/opus on Chrome, mp4/aac on Safari. Deepgram
 * reads both from the container header, so no `encoding` parameter is sent. */
export function pickMimeType(recorder: Pick<typeof MediaRecorder, "isTypeSupported">): string | undefined {
  return MIME_TYPES.find((t) => recorder.isTypeSupported(t));
}

export function listenUrl(token: Pick<VoiceToken, "model" | "language" | "tag">): string {
  const params = new URLSearchParams({
    model: token.model,
    language: token.language,
    interim_results: "true",
    smart_format: "true",
    tag: token.tag,
  });
  return `${LISTEN_URL}?${params}`;
}

function micError(err: unknown): VoiceError {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return new VoiceError("permission", "Microphone access was refused");
  if (name === "NotFoundError" || name === "OverconstrainedError") return new VoiceError("no-mic", "No microphone found");
  return new VoiceError("no-mic", err instanceof Error ? err.message : "The microphone couldn't be opened");
}

interface DeepgramMessage {
  type?: string;
  is_final?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
}

export async function startDeepgram(callbacks: VoiceCallbacks, deps: DeepgramDeps): Promise<VoiceRecording> {
  const mimeType = pickMimeType(deps.MediaRecorder);
  if (!mimeType) throw new VoiceError("unsupported", "This browser can't record audio");

  // The token and the mic in parallel: both take a moment, and the mic prompt is the slow one.
  const micPromise = deps.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  let token: VoiceToken;
  let stream: MediaStream;
  try {
    [token, stream] = await Promise.all([deps.getToken(), micPromise.catch((err) => Promise.reject(micError(err)))]);
  } catch (err) {
    micPromise.then((s) => s.getTracks().forEach((t) => t.stop())).catch(() => {});
    throw err;
  }

  const finals: string[] = [];
  let interim = "";
  let stopping = false;
  let finished = false;
  let dropped = false;
  const joined = () => [...finals, interim].filter(Boolean).join(" ");

  // From here the mic is open: anything that throws while setting up must still let go of it.
  const setupFailed = (err: unknown) => {
    stream.getTracks().forEach((t) => t.stop());
    return new VoiceError("upstream", err instanceof Error ? err.message : String(err));
  };
  let ws: WebSocket;
  try {
    ws = new deps.WebSocket(listenUrl(token), ["bearer", token.token]);
  } catch (err) {
    throw setupFailed(err);
  }
  let recorder: MediaRecorder;
  try {
    recorder = new deps.MediaRecorder(stream, { mimeType });
  } catch (err) {
    ws.close();
    throw setupFailed(err);
  }
  const queue: Blob[] = [];
  let opened = false;
  let recorderStopped = false;
  let closeSent = false;

  let closed!: () => void;
  const closedPromise = new Promise<void>((resolve) => (closed = resolve));
  let openOk!: () => void;
  let openFailed!: (err: VoiceError) => void;
  const openPromise = new Promise<void>((resolve, reject) => {
    openOk = resolve;
    openFailed = reject;
  });

  let level: { stop(): void } = { stop() {} };
  try {
    level = startLevelMeter(stream, callbacks.onLevel, deps.AudioContext);
  } catch {
    // no level meter; recording works without it
  }

  function release() {
    level.stop();
    stream.getTracks().forEach((t) => t.stop());
  }

  /** Once, and only after the recorder has handed over its last chunk. */
  function sendClose() {
    if (closeSent || !recorderStopped || ws.readyState !== deps.WebSocket.OPEN) return;
    closeSent = true;
    ws.send(JSON.stringify({ type: "CloseStream" }));
  }

  recorder.ondataavailable = (e: BlobEvent) => {
    if (!e.data || e.data.size === 0) return;
    if (ws.readyState === deps.WebSocket.OPEN) ws.send(e.data);
    else if (ws.readyState === deps.WebSocket.CONNECTING) queue.push(e.data);
  };
  recorder.onstop = () => {
    recorderStopped = true;
    sendClose();
  };

  ws.onopen = () => {
    opened = true;
    for (const chunk of queue.splice(0)) ws.send(chunk);
    sendClose();
    openOk();
  };
  ws.onmessage = (e: MessageEvent) => {
    let msg: DeepgramMessage;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (msg.type !== "Results") return;
    const text = msg.channel?.alternatives?.[0]?.transcript?.trim() ?? "";
    if (msg.is_final) {
      if (text) finals.push(text);
      interim = "";
    } else {
      interim = text;
    }
    callbacks.onTranscript(joined());
  };
  ws.onclose = () => {
    closed();
    if (!opened) {
      // Refused at the handshake (a bad or expired token, no credit): Deepgram's side, not the
      // network, so start() rejects and the caller can fall back to the built-in engine.
      openFailed(new VoiceError("upstream", "Deepgram refused the connection"));
      return;
    }
    if (!stopping && !finished) {
      dropped = true;
      if (recorder.state !== "inactive") recorder.stop();
      release();
      callbacks.onError(new VoiceError("network", "The connection to Deepgram dropped"));
    }
  };
  ws.onerror = () => {
    // onclose follows with the details that matter; nothing to do here.
  };

  function abandon() {
    finished = true;
    stopping = true;
    recorder.ondataavailable = null;
    recorder.onstop = null;
    if (recorder.state !== "inactive") recorder.stop();
    ws.close();
    release();
  }

  let openTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Recording starts now so the first words are queued while the socket opens.
    recorder.start(250);
    await Promise.race([
      openPromise,
      new Promise<never>((_, reject) => {
        openTimer = setTimeout(() => reject(new VoiceError("upstream", "Deepgram didn't answer")), deps.openTimeoutMs ?? 8000);
      }),
    ]);
  } catch (err) {
    abandon();
    throw err instanceof VoiceError ? err : new VoiceError("upstream", String(err));
  } finally {
    clearTimeout(openTimer);
  }

  return {
    async stop() {
      if (finished) return { transcript: joined(), complete: !dropped };
      stopping = true;
      if (recorder.state !== "inactive") recorder.stop();
      let timedOut = false;
      if (!dropped) {
        await Promise.race([closedPromise, new Promise((r) => setTimeout(r, deps.finishTimeoutMs ?? 4000)).then(() => (timedOut = true))]);
      }
      finished = true;
      if (ws.readyState === deps.WebSocket.OPEN || ws.readyState === deps.WebSocket.CONNECTING) ws.close();
      release();
      // Whatever Deepgram didn't finalize in time is still shown, but a stop that never heard back
      // (a dead link swallows CloseStream) may be missing the last words: not complete, not sent.
      return { transcript: joined(), complete: !dropped && !timedOut };
    },
    cancel: abandon,
  };
}

function startLevelMeter(stream: MediaStream, onLevel: ((level: number) => void) | undefined, Ctx: typeof AudioContext | undefined): { stop(): void } {
  if (!onLevel || !Ctx) return { stop() {} };
  let ctx: AudioContext;
  try {
    ctx = new Ctx();
  } catch {
    return { stop() {} };
  }
  void ctx.resume?.().catch(() => {}); // Safari creates it suspended after an await
  let analyser: AnalyserNode;
  try {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    ctx.createMediaStreamSource(stream).connect(analyser);
  } catch {
    void ctx.close().catch(() => {});
    return { stop() {} };
  }
  const buf = new Uint8Array(analyser.fftSize);
  const timer = setInterval(() => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    onLevel(Math.min(1, Math.sqrt(sum / buf.length) * 3));
  }, 100);
  return {
    stop() {
      clearInterval(timer);
      void ctx.close().catch(() => {});
    },
  };
}

// ---------- built-in (Web Speech API) ----------

interface SpeechResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<SpeechResultLike> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** Chrome still prefixes it; Safari has both. */
export function builtinRecognition(win: unknown = typeof window === "undefined" ? undefined : window): SpeechRecognitionCtor | undefined {
  const w = win as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor } | undefined;
  return w?.SpeechRecognition ?? w?.webkitSpeechRecognition;
}

export interface BuiltinDeps {
  Recognition: SpeechRecognitionCtor | undefined;
  language: string;
  finishTimeoutMs?: number;
}

export async function startBuiltin(callbacks: VoiceCallbacks, deps: BuiltinDeps): Promise<VoiceRecording> {
  if (!deps.Recognition) throw new VoiceError("unsupported", "This browser has no built-in speech recognition");
  const rec = new deps.Recognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = deps.language;

  // Chrome ends a continuous session on its own after a silence; we restart it, and each restart
  // begins a fresh results list, so what earlier rounds finalized is kept here.
  const committed: string[] = [];
  let round: string[] = [];
  let interim = "";
  let stopping = false;
  let finished = false;
  let failed: VoiceError | undefined;
  const joined = () => [...committed, ...round, interim].filter(Boolean).join(" ");

  let ended!: () => void;
  let endedPromise = new Promise<void>((r) => (ended = r));

  // Until start() returns, a refusal rejects start(); after that it goes to onError.
  let awaitingStart = true;
  let startFailed!: (err: VoiceError) => void;
  const startPromise = new Promise<void>((_resolve, reject) => (startFailed = reject));
  startPromise.catch(() => {}); // settled by the race below or never; don't report it twice

  rec.onresult = (e) => {
    round = [];
    interim = "";
    for (let i = 0; i < e.results.length; i++) {
      const r = e.results[i];
      const text = r[0].transcript.trim();
      if (!text) continue;
      if (r.isFinal) round.push(text);
      else interim = interim ? `${interim} ${text}` : text;
    }
    callbacks.onTranscript(joined());
  };
  rec.onerror = (e) => {
    const kind: VoiceErrorKind | undefined =
      e.error === "not-allowed" || e.error === "service-not-allowed"
        ? "permission"
        : e.error === "audio-capture"
          ? "no-mic"
          : e.error === "network"
            ? "network"
            : undefined; // "no-speech", "aborted": not failures
    if (!kind) return;
    failed = new VoiceError(kind, `Speech recognition failed: ${e.error}`);
    if (awaitingStart) startFailed(failed);
    else callbacks.onError(failed);
  };
  rec.onend = () => {
    committed.push(...round);
    round = [];
    if (!stopping && !failed && !finished) {
      endedPromise = new Promise<void>((r) => (ended = r));
      try {
        rec.start();
        return;
      } catch {
        // fall through: treat as ended
      }
    }
    ended();
  };

  rec.start();
  // SpeechRecognition has no "listening" event both browsers fire reliably; the mic is live once
  // start() returns, and a refusal arrives as onerror shortly after. Give it a moment.
  try {
    await Promise.race([startPromise, new Promise<void>((r) => setTimeout(r, 400))]);
  } finally {
    awaitingStart = false;
  }
  if (failed) {
    rec.abort();
    throw failed;
  }

  return {
    async stop() {
      if (finished) return { transcript: joined(), complete: !failed };
      stopping = true;
      rec.stop();
      let timedOut = false;
      await Promise.race([endedPromise, new Promise((r) => setTimeout(r, deps.finishTimeoutMs ?? 3000)).then(() => (timedOut = true))]);
      finished = true;
      // Nothing may arrive after this: a late result would overwrite a draft the person is already
      // editing. A recognizer that never ended is aborted.
      rec.onresult = null;
      rec.onerror = null;
      if (timedOut) rec.abort();
      committed.push(...round);
      round = [];
      const transcript = [...committed, interim].filter(Boolean).join(" ");
      return { transcript, complete: !failed && !timedOut };
    },
    cancel() {
      finished = true;
      stopping = true;
      rec.onresult = null;
      rec.abort();
    },
  };
}
