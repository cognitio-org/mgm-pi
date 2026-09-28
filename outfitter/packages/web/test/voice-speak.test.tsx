// @vitest-environment jsdom
// #255 spoken replies and hands-free, end to end in the Composer with fake speech and fake mic
// engines: which replies are read (new ones, not history), the speaker toggle and voice picker, the
// mic coming first, Esc, and the hands-free loop (read → mic reopens → a pause sends → next reply).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Composer } from "../src/components/Composer.tsx";
import type { PiEntry } from "../src/api/client.ts";
import type { VoiceEngines } from "../src/hooks/useVoice.ts";
import { HANDS_FREE_NO_SPEECH_MS, HANDS_FREE_SILENCE_MS } from "../src/hooks/useVoice.ts";
import type { SpeechStarter } from "../src/hooks/useSpeaker.ts";
import type { SpeechOutcome } from "../src/lib/voice-tts.ts";
import type { VoiceCallbacks, VoiceResult } from "../src/lib/voice-engines.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Spoken {
  sentences: string[];
  engine: string;
  voice: string;
  stopped: boolean;
  end(o?: SpeechOutcome): void;
}
interface Rec {
  cb: VoiceCallbacks;
  result: VoiceResult;
  stopped: boolean;
  cancelled: boolean;
}

let host: HTMLDivElement;
let root: Root;
let spoken: Spoken[];
let recs: Rec[];
let sent: string[];
let calls: Array<{ method: string; path: string; body?: unknown }>;
let prefs: { afterSpeaking: string; ttsVoice: string; handsFree: boolean };
let clock: number;

const speech: SpeechStarter = (sentences, engine, voice) => {
  let finish!: (o: SpeechOutcome) => void;
  const done = new Promise<SpeechOutcome>((r) => (finish = r));
  const s: Spoken = { sentences, engine, voice, stopped: false, end: (o = "done") => finish(o) };
  spoken.push(s);
  return {
    done,
    stop() {
      s.stopped = true;
      finish("stopped");
    },
  };
};

const engines: VoiceEngines = {
  deepgram: async (cb) => {
    const r: Rec = { cb, result: { transcript: "", complete: true }, stopped: false, cancelled: false };
    recs.push(r);
    return {
      async stop() {
        r.stopped = true;
        return r.result;
      },
      cancel() {
        r.cancelled = true;
      },
    };
  },
  builtin: async () => {
    throw new Error("not used");
  },
  builtinAvailable: true,
};

const reply = (id: string, text: string): PiEntry => ({ id, type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });
const user = (id: string, text: string): PiEntry => ({ id, type: "message", message: { role: "user", content: text } });

beforeEach(() => {
  spoken = [];
  recs = [];
  sent = [];
  calls = [];
  clock = 1_000_000;
  prefs = { afterSpeaking: "send", ttsVoice: "aura-2-hermes-en", handsFree: false };
  window.localStorage.clear();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "/api/me/voice" && method === "GET") return json({ deepgram: true, model: "nova-3", language: "en", prefs });
      if (path === "/api/me/voice" && method === "PUT") return json({ prefs: { ...prefs, ...body } });
      if (path.endsWith("/voice") && method === "PUT") return json({ voiceEngine: "deepgram", voiceSpeak: body.speak ?? false });
      if (path === "/api/me/voice/spend") return json({ available: false });
      return new Response("{}", { status: 404 });
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function flush() {
  for (let i = 0; i < 8; i++) await act(async () => await Promise.resolve());
}

let props: { entries: PiEntry[]; entriesLoaded?: boolean; voiceSpeak?: boolean; agentBusy?: boolean };

async function render(next: Partial<typeof props> = {}) {
  props = { ...props, ...next };
  await act(async () => {
    root.render(
      <Composer
        sessionId="s1"
        voiceEngines={engines}
        speech={speech}
        entries={props.entries}
        entriesLoaded={props.entriesLoaded}
        voiceSpeak={props.voiceSpeak}
        agentBusy={props.agentBusy}
        onSend={async (text) => void sent.push(text)}
      />,
    );
  });
  await flush();
}

async function mount(initial: Partial<typeof props> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  props = { entries: [], entriesLoaded: true, voiceSpeak: false, agentBusy: false };
  await render(initial);
}

const speakerButton = () => host.querySelector<HTMLButtonElement>(".voice-speaker")!;
const mic = () => host.querySelector<HTMLButtonElement>(".voice-mic")!;
const ta = () => host.querySelector("textarea")!;

async function pointer(type: "pointerdown" | "pointerup", afterMs = 0) {
  clock += afterMs;
  await act(async () => void mic().dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 })));
  await flush();
}

/** Lets the hands-free timer (a real 250 ms interval) run after moving the fake clock. */
async function advance(ms: number) {
  clock += ms;
  await act(async () => await new Promise((r) => setTimeout(r, 300)));
  await flush();
}

describe("reading replies aloud", () => {
  it("reads new replies when the speaker is on, never the history already on the page", async () => {
    await mount({ entries: [user("u0", "old question"), reply("a0", "An old answer.")], voiceSpeak: true });
    expect(spoken).toHaveLength(0);
    await render({ entries: [...props.entries, user("u1", "new question"), reply("a1", "I fixed the **login** bug. All tests pass.")] });
    expect(spoken).toHaveLength(1);
    expect(spoken[0].sentences).toEqual(["I fixed the login bug.", "All tests pass."]);
    expect(spoken[0].voice).toBe("aura-2-hermes-en");
    expect(spoken[0].engine).toBe("deepgram");
  });

  it("history that lands after the first render (the page's real load order) isn't read", async () => {
    await mount({ entries: [], entriesLoaded: false, voiceSpeak: true });
    // The history arrives a moment later, then the fetch reports done.
    await render({ entries: [user("u0", "old"), reply("a0", "An old answer from yesterday.")] });
    await render({ entriesLoaded: true });
    expect(spoken).toHaveLength(0);
    await render({ entries: [...props.entries, reply("a1", "A new answer.")] });
    expect(spoken.map((x) => x.sentences)).toEqual([["A new answer."]]);
  });

  it("the speaker off reads nothing, and turning it on doesn't read what already arrived", async () => {
    await mount();
    await render({ entries: [reply("a1", "Arrived while off.")] });
    await act(async () => speakerButton().click());
    await flush();
    expect(speakerButton().getAttribute("aria-pressed")).toBe("true");
    expect(calls).toContainEqual({ method: "PUT", path: "/api/sessions/s1/voice", body: { speak: true } });
    expect(spoken).toHaveLength(0);
    await render({ entries: [...props.entries, reply("a2", "Arrived while on.")] });
    expect(spoken.map((s) => s.sentences)).toEqual([["Arrived while on."]]);
  });

  it("queues replies one after another, and an all-code reply says nothing", async () => {
    await mount({ voiceSpeak: true });
    await render({ entries: [reply("a1", "First reply here."), reply("a2", "```\ncode only\n```"), reply("a3", "Third reply here.")] });
    expect(spoken).toHaveLength(1);
    await act(async () => spoken[0].end());
    await flush();
    expect(spoken.map((s) => s.sentences[0])).toEqual(["First reply here.", "Third reply here."]);
  });

  it("the mic comes first: pressing it stops speech, and nothing is read while it's live", async () => {
    await mount({ voiceSpeak: true });
    await render({ entries: [reply("a1", "A long reply being read.")] });
    await pointer("pointerdown");
    expect(spoken[0].stopped).toBe(true);
    await render({ entries: [...props.entries, reply("a2", "Arrives while recording.")] });
    expect(spoken).toHaveLength(1);
    await pointer("pointerup", 1000); // stops (empty transcript: nothing sent)
    expect(spoken.map((s) => s.sentences[0])).toEqual(["A long reply being read.", "Arrives while recording."]);
  });

  it("Esc stops a reply being read", async () => {
    await mount({ voiceSpeak: true });
    await render({ entries: [reply("a1", "Being read now.")] });
    await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(spoken[0].stopped).toBe(true);
  });

  it("the reply voice is chosen in the menu and saved", async () => {
    await mount({ voiceSpeak: true });
    await act(async () => host.querySelector<HTMLButtonElement>(".voice-options")!.click());
    await flush();
    const select = host.querySelector<HTMLSelectElement>(".voice-tts-voice select")!;
    expect(select.value).toBe("aura-2-hermes-en");
    await act(async () => {
      select.value = "aura-2-thalia-en";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(calls).toContainEqual({ method: "PUT", path: "/api/me/voice", body: { ttsVoice: "aura-2-thalia-en" } });
    await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await render({ entries: [reply("a1", "Read in the new voice.")] });
    expect(spoken[0].voice).toBe("aura-2-thalia-en");
  });
});

describe("hands-free", () => {
  async function turnOnHandsFree() {
    await act(async () => host.querySelector<HTMLButtonElement>(".voice-options")!.click());
    await flush();
    const item = Array.from(host.querySelectorAll<HTMLButtonElement>("[role='menuitemcheckbox']")).find((b) => /Hands-free/.test(b.textContent ?? ""))!;
    await act(async () => item.click());
    await flush();
    await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  }

  it("turning it on also turns the speaker on, and is saved", async () => {
    await mount();
    await turnOnHandsFree();
    expect(calls).toContainEqual({ method: "PUT", path: "/api/me/voice", body: { handsFree: true } });
    expect(speakerButton().getAttribute("aria-pressed")).toBe("true");
  });

  it("the loop: a pause after speaking sends; the reply is read; once the agent is idle the mic reopens", async () => {
    prefs.handsFree = true;
    prefs.afterSpeaking = "review"; // hands-free sends regardless
    await mount({ voiceSpeak: true });
    // You start the loop with a tap.
    await pointer("pointerdown");
    await pointer("pointerup", 100);
    await act(async () => recs[0].cb.onTranscript("fix the login bug"));
    recs[0].result = { transcript: "fix the login bug", complete: true };
    await advance(HANDS_FREE_SILENCE_MS - 500);
    expect(sent).toEqual([]); // still within the pause
    await advance(600);
    expect(sent).toEqual(["fix the login bug"]);
    // The agent works, replies, finishes.
    await render({ agentBusy: true, entries: [user("u1", "fix the login bug"), reply("a1", "Done. It works now.")] });
    expect(spoken).toHaveLength(1);
    await act(async () => spoken[0].end());
    await flush();
    expect(recs).toHaveLength(1); // the agent is still busy: the mic waits
    await render({ agentBusy: false });
    expect(recs).toHaveLength(2); // your turn: the mic reopened by itself
    expect(mic().getAttribute("aria-pressed")).toBe("true");
  });

  it("results repeating the same words through a silence don't hold the pause open", async () => {
    prefs.handsFree = true;
    await mount({ voiceSpeak: true });
    await pointer("pointerdown");
    await pointer("pointerup", 100);
    await act(async () => recs[0].cb.onTranscript("fix the login bug"));
    recs[0].result = { transcript: "fix the login bug", complete: true };
    // Deepgram keeps sending results during the silence, each with the same transcript so far.
    for (let i = 0; i < 4; i++) {
      await act(async () => recs[0].cb.onTranscript("fix the login bug"));
      await advance(500);
    }
    expect(sent).toEqual(["fix the login bug"]);
  });

  it("a reopened mic that hears nothing closes and pauses the loop, without sending", async () => {
    prefs.handsFree = true;
    await mount({ voiceSpeak: true });
    await render({ entries: [reply("a1", "Your turn.")] });
    await act(async () => spoken[0].end());
    await flush();
    expect(recs).toHaveLength(1);
    await advance(HANDS_FREE_NO_SPEECH_MS + 100);
    expect(recs[0].cancelled).toBe(true);
    expect(sent).toEqual([]);
    expect(host.querySelector(".voice-note")?.textContent).toMatch(/Hands-free paused/);
    // Paused: the next reply is read but the mic doesn't reopen until you press it.
    await render({ entries: [...props.entries, reply("a2", "Another one.")] });
    await act(async () => spoken[1].end());
    await flush();
    expect(recs).toHaveLength(1);
  });

  it("Esc while a reply is read stops it and pauses the loop", async () => {
    prefs.handsFree = true;
    await mount({ voiceSpeak: true });
    await render({ entries: [reply("a1", "Being read.")] });
    await act(async () => void document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(spoken[0].stopped).toBe(true);
    await flush();
    expect(recs).toHaveLength(0); // no reopen
  });

  it("without hands-free, a spoken reply never opens the mic", async () => {
    await mount({ voiceSpeak: true });
    await render({ entries: [reply("a1", "Just read.")] });
    await act(async () => spoken[0].end());
    await flush();
    expect(recs).toHaveLength(0);
  });
});
