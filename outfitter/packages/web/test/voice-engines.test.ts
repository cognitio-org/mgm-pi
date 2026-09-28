// #253: the two speech engines against fake browser APIs. Deepgram: token + mic in parallel, the
// socket authenticated with the token as a subprotocol, chunks queued until it opens, interim and
// final results, CloseStream after the last chunk, a dropped connection reported and never
// "complete". Built-in: continuous results, Chrome's silence auto-end restarted without losing
// what was said, refusals mapped.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listenUrl, startBuiltin, startDeepgram, VoiceError, type DeepgramDeps, type SpeechRecognitionCtor, type VoiceCallbacks } from "../src/lib/voice-engines.ts";

// ---------- fakes ----------

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

function fakeStream() {
  const track = new FakeTrack();
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track };
}

class FakeRecorder {
  static supported = new Set(["audio/webm;codecs=opus"]);
  static last: FakeRecorder | undefined;
  static isTypeSupported(t: string) {
    return FakeRecorder.supported.has(t);
  }
  state: "inactive" | "recording" = "inactive";
  timeslice = 0;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(
    public stream: MediaStream,
    public options: { mimeType: string },
  ) {
    FakeRecorder.last = this;
  }
  start(timeslice: number) {
    this.state = "recording";
    this.timeslice = timeslice;
  }
  chunk(text: string) {
    this.ondataavailable?.({ data: new Blob([text]) });
  }
  stop() {
    this.state = "inactive";
    this.chunk("last");
    this.onstop?.();
  }
}

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static last: FakeSocket | undefined;
  readyState = FakeSocket.CONNECTING;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(
    public url: string,
    public protocols: string[],
  ) {
    FakeSocket.last = this;
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }
  // server side
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  result(transcript: string, isFinal: boolean) {
    this.onmessage?.({ data: JSON.stringify({ type: "Results", is_final: isFinal, channel: { alternatives: [{ transcript }] } }) });
  }
  sentText(): string[] {
    return this.sent.filter((d): d is string => typeof d === "string");
  }
  sentChunks(): number {
    return this.sent.filter((d) => d instanceof Blob).length;
  }
}

const TOKEN = { token: "jwt-1", model: "nova-3", language: "en", tag: "outfitter-user-abc" };

function callbacks() {
  const transcripts: string[] = [];
  const errors: VoiceError[] = [];
  const cb: VoiceCallbacks = { onTranscript: (t) => transcripts.push(t), onError: (e) => errors.push(e) };
  return { cb, transcripts, errors };
}

function deps(over: Partial<DeepgramDeps> = {}) {
  const { stream, track } = fakeStream();
  const d: DeepgramDeps = {
    getToken: vi.fn(async () => TOKEN),
    getUserMedia: vi.fn(async () => stream),
    MediaRecorder: FakeRecorder as unknown as typeof MediaRecorder,
    WebSocket: FakeSocket as unknown as typeof WebSocket,
    finishTimeoutMs: 50,
    ...over,
  };
  return { d, track };
}

beforeEach(() => {
  FakeRecorder.supported = new Set(["audio/webm;codecs=opus"]);
  FakeRecorder.last = undefined;
  FakeSocket.last = undefined;
});

// ---------- Deepgram ----------

describe("startDeepgram", () => {
  it("opens the listen socket with the token as a bearer subprotocol, the tag, and no encoding", async () => {
    const { d } = deps();
    await startDeepgram(callbacks().cb, d);
    const ws = FakeSocket.last!;
    expect(ws.protocols).toEqual(["bearer", "jwt-1"]);
    const url = new URL(ws.url);
    expect(url.origin + url.pathname).toBe("wss://api.deepgram.com/v1/listen");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model: "nova-3",
      language: "en",
      interim_results: "true",
      smart_format: "true",
      tag: "outfitter-user-abc",
    });
    expect(listenUrl(TOKEN)).toBe(ws.url);
    expect(FakeRecorder.last!.options.mimeType).toBe("audio/webm;codecs=opus");
    expect(FakeRecorder.last!.timeslice).toBe(250);
  });

  it("records Safari's mp4 when webm isn't there", async () => {
    FakeRecorder.supported = new Set(["audio/mp4"]);
    await startDeepgram(callbacks().cb, deps().d);
    expect(FakeRecorder.last!.options.mimeType).toBe("audio/mp4");
  });

  it("queues audio until the socket opens, then streams it", async () => {
    await startDeepgram(callbacks().cb, deps().d);
    const rec = FakeRecorder.last!;
    const ws = FakeSocket.last!;
    rec.chunk("a");
    rec.chunk("b");
    expect(ws.sentChunks()).toBe(0);
    ws.open();
    expect(ws.sentChunks()).toBe(2);
    rec.chunk("c");
    expect(ws.sentChunks()).toBe(3);
  });

  it("reports interim and final text, sends CloseStream after the last chunk, and resolves on close", async () => {
    const { cb, transcripts } = callbacks();
    const { d, track } = deps();
    const recording = await startDeepgram(cb, d);
    const ws = FakeSocket.last!;
    ws.open();
    ws.result("hello", false);
    ws.result("hello world", true);
    ws.result("how are", false);
    expect(transcripts).toEqual(["hello", "hello world", "hello world how are"]);

    const done = recording.stop();
    // The last chunk went out before CloseStream.
    expect(ws.sent.at(-2)).toBeInstanceOf(Blob);
    expect(ws.sentText()).toEqual([JSON.stringify({ type: "CloseStream" })]);
    ws.result("how are you", true);
    ws.close();
    await expect(done).resolves.toEqual({ transcript: "hello world how are you", complete: true });
    expect(track.stopped).toBe(true);
  });

  it("keeps unfinalized words if Deepgram doesn't close in time", async () => {
    const recording = await startDeepgram(callbacks().cb, deps().d);
    const ws = FakeSocket.last!;
    ws.open();
    ws.result("one", true);
    ws.result("two", false);
    await expect(recording.stop()).resolves.toEqual({ transcript: "one two", complete: true });
    expect(ws.readyState).toBe(FakeSocket.CLOSED);
  });

  it("a dropped connection is reported, frees the mic, and the result is never complete", async () => {
    const { cb, errors } = callbacks();
    const { d, track } = deps();
    const recording = await startDeepgram(cb, d);
    const ws = FakeSocket.last!;
    ws.open();
    ws.result("half a", true);
    ws.close(); // server-side drop while recording
    expect(errors.map((e) => e.kind)).toEqual(["network"]);
    expect(track.stopped).toBe(true);
    await expect(recording.stop()).resolves.toEqual({ transcript: "half a", complete: false });
  });

  it("cancel closes everything and sends no CloseStream", async () => {
    const { d, track } = deps();
    const recording = await startDeepgram(callbacks().cb, d);
    const ws = FakeSocket.last!;
    ws.open();
    recording.cancel();
    expect(ws.readyState).toBe(FakeSocket.CLOSED);
    expect(ws.sentText()).toEqual([]);
    expect(track.stopped).toBe(true);
  });

  it("a refused mic is a permission error, and no socket is opened", async () => {
    const { d } = deps({ getUserMedia: vi.fn(async () => Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" }))) });
    await expect(startDeepgram(callbacks().cb, d)).rejects.toMatchObject({ kind: "permission" });
    expect(FakeSocket.last).toBeUndefined();
  });

  it("a missing mic is no-mic", async () => {
    const { d } = deps({ getUserMedia: vi.fn(async () => Promise.reject(Object.assign(new Error("none"), { name: "NotFoundError" }))) });
    await expect(startDeepgram(callbacks().cb, d)).rejects.toMatchObject({ kind: "no-mic" });
  });

  it("a token failure passes through and releases the mic it already opened", async () => {
    const { d, track } = deps({ getToken: vi.fn(async () => Promise.reject(new VoiceError("disabled", "off"))) });
    await expect(startDeepgram(callbacks().cb, d)).rejects.toMatchObject({ kind: "disabled" });
    await Promise.resolve();
    expect(track.stopped).toBe(true);
    expect(FakeSocket.last).toBeUndefined();
  });

  it("no recordable format is unsupported", async () => {
    FakeRecorder.supported = new Set();
    await expect(startDeepgram(callbacks().cb, deps().d)).rejects.toMatchObject({ kind: "unsupported" });
  });
});

// ---------- built-in ----------

type Result = { isFinal: boolean; 0: { transcript: string } };

class FakeRecognition {
  static last: FakeRecognition | undefined;
  continuous = false;
  interimResults = false;
  lang = "";
  starts = 0;
  aborted = false;
  onresult: ((e: { resultIndex: number; results: Result[] }) => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() {
    FakeRecognition.last = this;
  }
  start() {
    this.starts++;
  }
  stop() {
    queueMicrotask(() => this.onend?.());
  }
  abort() {
    this.aborted = true;
  }
  results(...items: Array<[string, boolean]>) {
    this.onresult?.({ resultIndex: 0, results: items.map(([t, f]) => ({ isFinal: f, 0: { transcript: t } })) });
  }
}

const Recognition = FakeRecognition as unknown as SpeechRecognitionCtor;

describe("startBuiltin", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function started(cb: VoiceCallbacks) {
    const p = startBuiltin(cb, { Recognition, language: "en-US", finishTimeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(400);
    return p;
  }

  it("listens continuously with interim results in the page's language, and joins what it heard", async () => {
    const { cb, transcripts } = callbacks();
    const recording = await started(cb);
    const rec = FakeRecognition.last!;
    expect([rec.continuous, rec.interimResults, rec.lang]).toEqual([true, true, "en-US"]);
    rec.results(["open the", false]);
    rec.results(["open the file", true], ["and", false]);
    expect(transcripts).toEqual(["open the", "open the file and"]);
    const done = recording.stop();
    await vi.advanceTimersByTimeAsync(0);
    await expect(done).resolves.toEqual({ transcript: "open the file and", complete: true });
  });

  it("restarts after Chrome's silence auto-end without losing what was said", async () => {
    const { cb, transcripts } = callbacks();
    const recording = await started(cb);
    const rec = FakeRecognition.last!;
    rec.results(["first part", true]);
    rec.onend!(); // Chrome ended the session on its own
    expect(rec.starts).toBe(2);
    rec.results(["second part", true]); // a fresh results list
    expect(transcripts.at(-1)).toBe("first part second part");
    const done = recording.stop();
    await vi.advanceTimersByTimeAsync(0);
    await expect(done).resolves.toEqual({ transcript: "first part second part", complete: true });
  });

  it("a refusal right after start rejects with permission", async () => {
    const p = startBuiltin(callbacks().cb, { Recognition, language: "en" });
    const assertion = expect(p).rejects.toMatchObject({ kind: "permission" });
    FakeRecognition.last!.onerror!({ error: "not-allowed" });
    await vi.advanceTimersByTimeAsync(400);
    await assertion;
  });

  it("a later network error is reported and the result isn't complete; no-speech isn't an error", async () => {
    const { cb, errors } = callbacks();
    const recording = await started(cb);
    const rec = FakeRecognition.last!;
    rec.onerror!({ error: "no-speech" });
    expect(errors).toEqual([]);
    rec.results(["partial", true]);
    rec.onerror!({ error: "network" });
    expect(errors.map((e) => e.kind)).toEqual(["network"]);
    const done = recording.stop();
    await vi.advanceTimersByTimeAsync(50);
    await expect(done).resolves.toEqual({ transcript: "partial", complete: false });
  });

  it("no SpeechRecognition here is unsupported", async () => {
    await expect(startBuiltin(callbacks().cb, { Recognition: undefined, language: "en" })).rejects.toMatchObject({ kind: "unsupported" });
  });

  it("cancel aborts", async () => {
    const recording = await started(callbacks().cb);
    recording.cancel();
    expect(FakeRecognition.last!.aborted).toBe(true);
  });
});
