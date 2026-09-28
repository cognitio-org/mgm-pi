// #255: the two speech engines against fake browser APIs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pcm16ToFloat, speakBuiltin, speakDeepgram, speakUrl } from "../src/lib/voice-tts.ts";

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static last: FakeSocket | undefined;
  readyState = 0;
  binaryType = "";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string, public protocols: string[]) {
    FakeSocket.last = this;
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  audio(samples: number[]) {
    const b = new ArrayBuffer(samples.length * 2);
    const v = new DataView(b);
    samples.forEach((s, i) => v.setInt16(i * 2, s, true));
    this.onmessage?.({ data: b });
  }
  text(o: unknown) {
    this.onmessage?.({ data: JSON.stringify(o) });
  }
}

class FakeSource {
  buffer: { duration: number } | null = null;
  startedAt = -1;
  stopped = false;
  onended: (() => void) | null = null;
  connect() {}
  start(t: number) {
    this.startedAt = t;
  }
  stop() {
    this.stopped = true;
  }
}

function fakeAudio() {
  const sources: FakeSource[] = [];
  const ctx = {
    currentTime: 10,
    destination: {},
    createBuffer: (_ch: number, length: number, rate: number) => {
      const data = new Float32Array(length);
      return { duration: length / rate, getChannelData: () => data };
    },
    createBufferSource: () => {
      const s = new FakeSource();
      sources.push(s);
      return s;
    },
  };
  return { ctx: ctx as unknown as AudioContext, sources };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  FakeSocket.last = undefined;
});

describe("speakDeepgram", () => {
  it("opens the speak socket with the token, sends each sentence then Flush, and plays gaplessly", async () => {
    const { ctx, sources } = fakeAudio();
    const speech = speakDeepgram(["Hello there.", "Second one."], "aura-2-hermes-en", {
      getToken: async () => ({ token: "jwt", tag: "outfitter-user-abc" }),
      WebSocket: FakeSocket as unknown as typeof WebSocket,
      audio: ctx,
    });
    await flush();
    const ws = FakeSocket.last!;
    expect(ws.protocols).toEqual(["bearer", "jwt"]);
    expect(ws.url).toBe(speakUrl("aura-2-hermes-en", "outfitter-user-abc"));
    expect(new URL(ws.url).searchParams.get("encoding")).toBe("linear16");
    ws.open();
    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([{ type: "Speak", text: "Hello there." }, { type: "Speak", text: "Second one." }, { type: "Flush" }]);
    ws.audio(new Array(2400).fill(1000)); // 0.1 s at 24 kHz
    ws.audio(new Array(4800).fill(-1000)); // 0.2 s
    expect(sources[0].startedAt).toBe(10);
    expect(sources[1].startedAt).toBeCloseTo(10.1);
    ws.text({ type: "Flushed" });
    expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ type: "Close" });
    let outcome: string | undefined;
    void speech.done.then((o) => (outcome = o));
    await flush();
    expect(outcome).toBeUndefined(); // 0.3 s of audio still to play
    await new Promise((r) => setTimeout(r, 400));
    expect(outcome).toBe("done");
  });

  it("settles by the clock: at once when the audio has already played out, soon on a suspended context", async () => {
    const played = fakeAudio();
    const a = speakDeepgram(["x"], "v", { getToken: async () => ({ token: "t", tag: "g" }), WebSocket: FakeSocket as unknown as typeof WebSocket, audio: played.ctx });
    await flush();
    FakeSocket.last!.open();
    FakeSocket.last!.audio([1, 2]);
    (played.ctx as { currentTime: number }).currentTime = 99; // playback caught up
    FakeSocket.last!.text({ type: "Flushed" });
    await expect(a.done).resolves.toBe("done");

    const suspended = fakeAudio();
    Object.assign(suspended.ctx, { state: "suspended" });
    const b = speakDeepgram(["x"], "v", { getToken: async () => ({ token: "t", tag: "g" }), WebSocket: FakeSocket as unknown as typeof WebSocket, audio: suspended.ctx });
    await flush();
    FakeSocket.last!.open();
    FakeSocket.last!.audio(new Array(24000 * 5).fill(1)); // 5 s that a suspended context won't play
    FakeSocket.last!.text({ type: "Flushed" });
    const t0 = Date.now();
    await expect(b.done).resolves.toBe("done");
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(suspended.sources.every((src) => src.stopped)).toBe(true); // nothing left to burst out later
  });

  it("an odd byte split across frames is carried over", async () => {
    const { ctx, sources } = fakeAudio();
    speakDeepgram(["x"], "v", { getToken: async () => ({ token: "t", tag: "g" }), WebSocket: FakeSocket as unknown as typeof WebSocket, audio: ctx });
    await flush();
    const ws = FakeSocket.last!;
    ws.open();
    ws.onmessage!({ data: new Uint8Array([1, 2, 3]).buffer });
    ws.onmessage!({ data: new Uint8Array([4]).buffer });
    const lengths = sources.map((s) => (s.buffer as { duration: number }).duration * 24000);
    expect(lengths.map(Math.round)).toEqual([1, 1]);
  });

  it("stop halts every source and closes the socket", async () => {
    const { ctx, sources } = fakeAudio();
    const speech = speakDeepgram(["x"], "v", { getToken: async () => ({ token: "t", tag: "g" }), WebSocket: FakeSocket as unknown as typeof WebSocket, audio: ctx });
    await flush();
    FakeSocket.last!.open();
    FakeSocket.last!.audio([1, 2, 3, 4]);
    speech.stop();
    expect(sources.every((s) => s.stopped)).toBe(true);
    expect(FakeSocket.last!.readyState).toBe(3);
    await expect(speech.done).resolves.toBe("stopped");
  });

  it("a token failure, or a socket closed with no audio, is an error", async () => {
    const { ctx } = fakeAudio();
    const noToken = speakDeepgram(["x"], "v", { getToken: async () => Promise.reject(new Error("404")), WebSocket: FakeSocket as unknown as typeof WebSocket, audio: ctx });
    await expect(noToken.done).resolves.toBe("error");
    const refused = speakDeepgram(["x"], "v", { getToken: async () => ({ token: "t", tag: "g" }), WebSocket: FakeSocket as unknown as typeof WebSocket, audio: ctx });
    await flush();
    FakeSocket.last!.close();
    await expect(refused.done).resolves.toBe("error");
  });
});

describe("pcm16ToFloat", () => {
  it("scales little-endian 16-bit samples to [-1, 1]", () => {
    const b = new ArrayBuffer(4);
    new DataView(b).setInt16(0, 16384, true);
    new DataView(b).setInt16(2, -32768, true);
    expect(Array.from(pcm16ToFloat(b))).toEqual([0.5, -1]);
  });
});

describe("speakBuiltin", () => {
  function fakeSynth() {
    const spoken: Array<{ text: string; lang: string; onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null }> = [];
    const synth = { speak: vi.fn((u) => spoken.push(u)), cancel: vi.fn() };
    const Utterance = class {
      lang = "";
      onend: (() => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      constructor(public text: string) {}
    };
    return { synth, Utterance: Utterance as unknown as typeof SpeechSynthesisUtterance, spoken };
  }
  it("queues one utterance per sentence and resolves when the last ends", async () => {
    const f = fakeSynth();
    const speech = speakBuiltin(["One.", "Two."], { synth: f.synth, Utterance: f.Utterance, lang: "en-US" });
    expect(f.spoken.map((u) => [u.text, u.lang])).toEqual([["One.", "en-US"], ["Two.", "en-US"]]);
    f.spoken[1].onend!();
    await expect(speech.done).resolves.toBe("done");
  });
  it("stop cancels speech", async () => {
    const f = fakeSynth();
    const speech = speakBuiltin(["One."], { synth: f.synth, Utterance: f.Utterance, lang: "en" });
    speech.stop();
    expect(f.synth.cancel).toHaveBeenCalled();
    await expect(speech.done).resolves.toBe("stopped");
  });
});
