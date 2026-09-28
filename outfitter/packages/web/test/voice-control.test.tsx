// @vitest-environment jsdom
// #253: the Composer's mic end to end with fake engines. Tap latches, hold talks, ⌥/Alt+Space does
// the same, Esc restores the draft, "after speaking" sends or leaves the text, a dropped connection
// is never sent, Deepgram falls back to the built-in engine, and the engine choice is saved.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Composer } from "../src/components/Composer.tsx";
import type { VoiceEngines } from "../src/hooks/useVoice.ts";
import { VoiceError, type VoiceCallbacks, type VoiceResult } from "../src/lib/voice-engines.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeRun {
  engine: "deepgram" | "builtin";
  cb: VoiceCallbacks;
  stopped: boolean;
  cancelled: boolean;
  result: VoiceResult;
}

let host: HTMLDivElement;
let root: Root;
let sent: Array<{ text: string; behavior?: string }>;
let runs: FakeRun[];
let calls: Array<{ method: string; path: string; body?: unknown }>;
let config: { deepgram: boolean; model: string; language: string; prefs: { afterSpeaking: "send" | "review" } };
let clock: number;
let deepgramFailure: VoiceError | undefined;

function engines(builtinAvailable = true): VoiceEngines {
  const make = (engine: "deepgram" | "builtin") => async (cb: VoiceCallbacks) => {
    if (engine === "deepgram" && deepgramFailure) throw deepgramFailure;
    const run: FakeRun = { engine, cb, stopped: false, cancelled: false, result: { transcript: "", complete: true } };
    runs.push(run);
    return {
      async stop() {
        run.stopped = true;
        return run.result;
      },
      cancel() {
        run.cancelled = true;
      },
    };
  };
  return { deepgram: make("deepgram"), builtin: make("builtin"), builtinAvailable };
}

beforeEach(() => {
  sent = [];
  runs = [];
  calls = [];
  clock = 1_000_000;
  deepgramFailure = undefined;
  config = { deepgram: true, model: "nova-3", language: "en", prefs: { afterSpeaking: "send" } };
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path === "/api/me/voice" && method === "GET") return json(config);
      if (path === "/api/me/voice" && method === "PUT") return json({ prefs: body });
      if (path.endsWith("/voice") && method === "PUT") return json({ voiceEngine: body.engine });
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

async function mount(opts: { builtinAvailable?: boolean; voiceEngine?: "deepgram" | "builtin" } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <Composer
        sessionId="s1"
        voiceEngine={opts.voiceEngine}
        voiceEngines={engines(opts.builtinAvailable ?? true)}
        onSend={async (text, behavior) => void sent.push({ text, behavior })}
      />,
    );
  });
  await flush();
}

const mic = () => host.querySelector<HTMLButtonElement>(".voice-mic")!;
const ta = () => host.querySelector("textarea")!;

async function pointer(type: "pointerdown" | "pointerup", afterMs = 0) {
  clock += afterMs;
  await act(async () => {
    mic().dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
  });
  await flush();
}

async function key(type: "keydown" | "keyup", init: KeyboardEventInit, afterMs = 0) {
  clock += afterMs;
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }));
  });
  await flush();
}

async function typeDraft(text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(ta(), text);
    ta().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function hear(text: string, final = true) {
  const run = runs.at(-1)!;
  await act(async () => run.cb.onTranscript(text));
  if (final) run.result = { transcript: text, complete: true };
}

describe("the mic button", () => {
  it("hold: records while held and sends on release (after speaking = send)", async () => {
    await mount();
    await pointer("pointerdown");
    expect(runs).toHaveLength(1);
    expect(runs[0].engine).toBe("deepgram");
    expect(mic().getAttribute("aria-pressed")).toBe("true");
    await hear("fix the login bug");
    expect(ta().value).toBe("fix the login bug");
    expect(ta().readOnly).toBe(true);
    await pointer("pointerup", 1500);
    expect(runs[0].stopped).toBe(true);
    expect(sent).toEqual([{ text: "fix the login bug", behavior: undefined }]);
    expect(ta().value).toBe("");
    expect(mic().getAttribute("aria-pressed")).toBe("false");
  });

  it("tap: latches on, keeps listening after release, stops on the next press", async () => {
    await mount();
    await pointer("pointerdown");
    await pointer("pointerup", 100);
    expect(runs[0].stopped).toBe(false);
    expect(mic().getAttribute("aria-pressed")).toBe("true");
    await hear("keep going");
    await pointer("pointerdown", 4000);
    expect(runs[0].stopped).toBe(true);
    expect(sent.map((s) => s.text)).toEqual(["keep going"]);
    await pointer("pointerup", 200); // the stopping press's release starts nothing
    expect(runs).toHaveLength(1);
  });

  it("appends to what was already typed", async () => {
    await mount();
    await typeDraft("Please");
    await pointer("pointerdown");
    await hear("add tests");
    expect(ta().value).toBe("Please add tests");
    await pointer("pointerup", 1000);
    expect(sent.map((s) => s.text)).toEqual(["Please add tests"]);
  });

  it("after speaking = review leaves the text in the box", async () => {
    config.prefs.afterSpeaking = "review";
    await mount();
    await pointer("pointerdown");
    await hear("draft this");
    await pointer("pointerup", 1000);
    expect(sent).toEqual([]);
    expect(ta().value).toBe("draft this");
    expect(ta().readOnly).toBe(false);
  });

  it("an empty transcript sends nothing", async () => {
    await mount();
    await pointer("pointerdown");
    await pointer("pointerup", 1000);
    expect(sent).toEqual([]);
  });

  it("a dropped connection keeps what was heard, says so, and never sends", async () => {
    await mount();
    await pointer("pointerdown");
    await hear("half of it", false);
    runs[0].result = { transcript: "half of it", complete: false };
    await pointer("pointerup", 1000);
    expect(sent).toEqual([]);
    expect(ta().value).toBe("half of it");
    expect(host.querySelector(".voice-note")?.textContent).toMatch(/dropped/);
  });

  it("a mid-recording error stops the mic and keeps the text", async () => {
    await mount();
    await pointer("pointerdown");
    await pointer("pointerup", 100); // latched
    await hear("so far", false);
    await act(async () => runs[0].cb.onError(new VoiceError("network", "gone")));
    await flush();
    expect(mic().getAttribute("aria-pressed")).toBe("false");
    expect(ta().value).toBe("so far");
    expect(sent).toEqual([]);
  });
});

describe("Esc", () => {
  it("cancels and puts the draft back as it was", async () => {
    await mount();
    await typeDraft("typed before");
    await pointer("pointerdown");
    await pointer("pointerup", 100);
    await hear("spoken words");
    expect(ta().value).toBe("typed before spoken words");
    await key("keydown", { key: "Escape" });
    expect(runs[0].cancelled).toBe(true);
    expect(ta().value).toBe("typed before");
    expect(sent).toEqual([]);
    expect(mic().getAttribute("aria-pressed")).toBe("false");
  });
});

describe("⌥/Alt+Space", () => {
  const down = { code: "Space", key: " ", altKey: true };

  it("hold talks until the key goes up", async () => {
    await mount();
    await key("keydown", down);
    await key("keydown", { ...down, repeat: true }, 50);
    expect(runs).toHaveLength(1);
    await hear("from the keyboard");
    await key("keyup", { code: "Space", key: " ", altKey: true }, 1200);
    expect(sent.map((s) => s.text)).toEqual(["from the keyboard"]);
  });

  it("releasing Alt first also ends the hold", async () => {
    await mount();
    await key("keydown", down);
    await hear("alt first");
    await key("keyup", { code: "AltLeft", key: "Alt" }, 1200);
    expect(sent.map((s) => s.text)).toEqual(["alt first"]);
  });

  it("tap latches, the next tap stops", async () => {
    await mount();
    await key("keydown", down);
    await key("keyup", { code: "Space", key: " " }, 80);
    expect(runs[0].stopped).toBe(false);
    await hear("tapped");
    await key("keydown", down, 3000);
    expect(runs[0].stopped).toBe(true);
    await key("keyup", { code: "Space", key: " " }, 80);
    expect(sent.map((s) => s.text)).toEqual(["tapped"]);
    expect(runs).toHaveLength(1);
  });

  it("is prevented so it can't type a non-breaking space", async () => {
    await mount();
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...down });
    await act(async () => void document.dispatchEvent(e));
    expect(e.defaultPrevented).toBe(true);
    await flush();
  });

  it("a plain Space keyup while typing doesn't stop a latched recording", async () => {
    await mount();
    await pointer("pointerdown");
    await pointer("pointerup", 100);
    await key("keyup", { code: "Space", key: " " }, 500);
    expect(runs[0].stopped).toBe(false);
  });
});

describe("engines", () => {
  it("uses the floppy's built-in choice", async () => {
    await mount({ voiceEngine: "builtin" });
    await pointer("pointerdown");
    expect(runs[0].engine).toBe("builtin");
  });

  it("uses built-in when Deepgram is off here", async () => {
    config.deepgram = false;
    await mount();
    await pointer("pointerdown");
    expect(runs[0].engine).toBe("builtin");
  });

  it("falls back to built-in when Deepgram refuses, and says why", async () => {
    deepgramFailure = new VoiceError("rate-limited", "slow down");
    await mount();
    await pointer("pointerdown");
    expect(runs.map((r) => r.engine)).toEqual(["builtin"]);
    expect(host.querySelector(".voice-note")?.textContent).toMatch(/built-in/);
  });

  it("a refused mic isn't papered over with the other engine", async () => {
    deepgramFailure = new VoiceError("permission", "no");
    await mount();
    await pointer("pointerdown");
    expect(runs).toHaveLength(0);
    expect(host.querySelector(".voice-note")?.textContent).toMatch(/refused/);
    expect(mic().getAttribute("aria-pressed")).toBe("false");
  });

  it("with neither engine available the mic is disabled", async () => {
    config.deepgram = false;
    await mount({ builtinAvailable: false });
    expect(mic().disabled).toBe(true);
  });
});

describe("the settings menu", () => {
  async function openMenu() {
    await act(async () => host.querySelector<HTMLButtonElement>(".voice-options")!.click());
  }
  const item = (label: RegExp) =>
    Array.from(host.querySelectorAll<HTMLButtonElement>(".voice-menu [role='menuitemradio']")).find((b) => label.test(b.textContent ?? ""))!;

  it("saves the floppy's engine and the person's after-speaking choice", async () => {
    await mount();
    await openMenu();
    expect(item(/Deepgram/).getAttribute("aria-checked")).toBe("true");
    expect(item(/Send it/).getAttribute("aria-checked")).toBe("true");
    await act(async () => item(/built-in/).click());
    await act(async () => item(/review/).click());
    await flush();
    expect(calls).toContainEqual({ method: "PUT", path: "/api/sessions/s1/voice", body: { engine: "builtin" } });
    expect(calls).toContainEqual({ method: "PUT", path: "/api/me/voice", body: { afterSpeaking: "review" } });
    expect(item(/built-in/).getAttribute("aria-checked")).toBe("true");
    await pointer("pointerdown");
    expect(runs[0].engine).toBe("builtin");
  });

  it("marks Deepgram unavailable when it's off here", async () => {
    config.deepgram = false;
    await mount();
    await openMenu();
    expect(item(/Deepgram/).disabled).toBe(true);
    expect(item(/Deepgram/).textContent).toMatch(/off here/);
  });
});

describe("Send while the mic is live", () => {
  it("is held off until the transcript is in", async () => {
    await mount();
    await pointer("pointerdown");
    await pointer("pointerup", 100); // latched
    await hear("not yet");
    const send = Array.from(host.querySelectorAll<HTMLButtonElement>(".send-wrap > button")).find((b) => /Send/.test(b.textContent ?? ""))!;
    expect(send.getAttribute("aria-disabled")).toBe("true");
    await act(async () => send.click());
    expect(sent).toEqual([]);
  });
});
