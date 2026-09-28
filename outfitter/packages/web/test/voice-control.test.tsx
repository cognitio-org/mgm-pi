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
let deviceIds: Array<string | undefined>;
/** When set, engine starts (and stops) wait for the test to release them. */
let deferred: boolean;
let pendingStarts: Array<() => void>;
let pendingStops: Array<() => void>;

function engines(builtinAvailable = true): VoiceEngines {
  const make = (engine: "deepgram" | "builtin") => async (cb: VoiceCallbacks, opts?: { deviceId?: string }) => {
    deviceIds.push(opts?.deviceId);
    if (deferred) await new Promise<void>((r) => pendingStarts.push(r));
    if (engine === "deepgram" && deepgramFailure) throw deepgramFailure;
    const run: FakeRun = { engine, cb, stopped: false, cancelled: false, result: { transcript: "", complete: true } };
    runs.push(run);
    return {
      async stop() {
        run.stopped = true;
        if (deferred) await new Promise<void>((r) => pendingStops.push(r));
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
  deviceIds = [];
  window.localStorage.clear();
  deferred = false;
  pendingStarts = [];
  pendingStops = [];
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
      if (path === "/api/me/voice/spend") return json({ available: true, currency: "USD", today: { minutes: 1, ttsCharacters: 0, usd: 0.0077 }, week: { minutes: 1, ttsCharacters: 0, usd: 0.0077 }, month: { minutes: 3, ttsCharacters: 0, usd: 0.0231 }, asOf: "x" });
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

  it("at the monthly cap it uses built-in and says why", async () => {
    deepgramFailure = new VoiceError("cap-reached", "cap");
    await mount();
    await pointer("pointerdown");
    expect(runs.map((r) => r.engine)).toEqual(["builtin"]);
    expect(host.querySelector(".voice-note")?.textContent).toMatch(/cap.*built-in/);
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

  it("shows your Deepgram spend", async () => {
    await mount();
    await openMenu();
    await flush();
    expect(host.querySelector(".voice-spend-line")?.textContent).toBe("$0.01 today · $0.01 week · $0.02 month");
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

describe("races (engines that take their time)", () => {
  async function releaseStart() {
    await act(async () => pendingStarts.shift()!());
    await flush();
  }

  it("leaving the page while the engine is starting cancels it once it has started", async () => {
    deferred = true;
    await mount();
    await pointer("pointerdown");
    act(() => root.unmount());
    await act(async () => pendingStarts.shift()!());
    await flush();
    expect(runs).toHaveLength(1);
    expect(runs[0].cancelled).toBe(true);
    root = createRoot(host); // afterEach unmounts again
  });

  it("Esc while starting, then a new press: the first start is cancelled, the second records", async () => {
    deferred = true;
    await mount();
    await key("keydown", { code: "Space", key: " ", altKey: true });
    await key("keydown", { key: "Escape" });
    await key("keyup", { code: "Space", key: " " }, 50);
    await key("keydown", { code: "Space", key: " ", altKey: true }, 100);
    await releaseStart(); // the first, abandoned start
    await releaseStart(); // the second
    expect(runs).toHaveLength(2);
    expect(runs[0].cancelled).toBe(true);
    expect(runs[1].cancelled).toBe(false);
    expect(mic().getAttribute("aria-pressed")).toBe("true");
  });

  it("a hold released before the engine started still stops (and sends) once it has", async () => {
    deferred = true;
    await mount();
    await pointer("pointerdown");
    await pointer("pointerup", 1000);
    await releaseStart();
    expect(runs[0].stopped).toBe(true);
    runs[0].result = { transcript: "quick one", complete: true };
    await act(async () => pendingStops.shift()!());
    await flush();
    expect(sent.map((x) => x.text)).toEqual(["quick one"]);
  });

  it("Esc while finishing stops the auto-send and puts the draft back", async () => {
    deferred = true;
    await mount();
    await typeDraft("typed");
    await pointer("pointerdown");
    await releaseStart();
    await hear("then spoken");
    await pointer("pointerup", 1000); // finishing: stop() is pending
    expect(host.querySelector(".voice-mic")!.classList.contains("is-finishing")).toBe(true);
    await key("keydown", { key: "Escape" });
    await act(async () => pendingStops.shift()!());
    await flush();
    expect(sent).toEqual([]);
    expect(ta().value).toBe("typed");
    expect(runs[0].cancelled).toBe(true);
  });

  it("a press while the last recording is finishing is ignored", async () => {
    deferred = true;
    await mount();
    await pointer("pointerdown");
    await releaseStart();
    await hear("first");
    await pointer("pointerup", 1000); // finishing
    await pointer("pointerdown", 50);
    expect(pendingStarts).toHaveLength(0);
    await act(async () => pendingStops.shift()!());
    await flush();
    expect(sent.map((x) => x.text)).toEqual(["first"]);
  });

  it("a press before the voice settings arrive tries Deepgram, not built-in", async () => {
    let answer!: (r: Response) => void;
    (globalThis.fetch as unknown as { mockImplementationOnce: (f: () => Promise<Response>) => void }).mockImplementationOnce(
      () => new Promise<Response>((r) => (answer = r)),
    );
    await mount();
    await pointer("pointerdown");
    expect(runs[0].engine).toBe("deepgram");
    answer(new Response(JSON.stringify(config), { status: 200 }));
  });
});

describe("more ways in", () => {
  it("a floppy set to built-in uses Deepgram in a browser without built-in speech", async () => {
    await mount({ voiceEngine: "builtin", builtinAvailable: false });
    await pointer("pointerdown");
    expect(runs[0].engine).toBe("deepgram");
  });

  it("keyboard activation of the focused button is a tap (latch, then stop)", async () => {
    await mount();
    await act(async () => mic().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    await flush();
    expect(mic().getAttribute("aria-pressed")).toBe("true");
    await hear("by keyboard");
    await act(async () => mic().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 })));
    await flush();
    expect(sent.map((x) => x.text)).toEqual(["by keyboard"]);
  });

  it("leaving the window mid-hold ends the hold", async () => {
    await mount();
    await key("keydown", { code: "Space", key: " ", altKey: true });
    await hear("then I switched apps");
    clock += 1000;
    await act(async () => void window.dispatchEvent(new Event("blur")));
    await flush();
    expect(sent.map((x) => x.text)).toEqual(["then I switched apps"]);
  });

  it("⌥/Alt+Space in another text field on the page is left alone", async () => {
    await mount();
    const other = document.createElement("input");
    document.body.appendChild(other);
    const e = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, code: "Space", key: " ", altKey: true });
    await act(async () => void other.dispatchEvent(e));
    await flush();
    expect(e.defaultPrevented).toBe(false);
    expect(runs).toHaveLength(0);
    other.remove();
  });

  it("the level meter writes the button's --voice-level", async () => {
    await mount();
    await pointer("pointerdown");
    await act(async () => runs[0].cb.onLevel?.(0.5));
    expect(mic().style.getPropertyValue("--voice-level")).toBe("0.5");
  });
});

describe("#267 choosing the microphone", () => {
  let listeners: Array<() => void>;
  let inputs: MediaDeviceInfo[];
  let granted: boolean;

  function stubDevices() {
    listeners = [];
    granted = false;
    const d = (deviceId: string, label: string) => ({ kind: "audioinput", deviceId, label, groupId: "g" }) as MediaDeviceInfo;
    inputs = [d("default", "Default - MacBook Pro Microphone"), d("mac", "MacBook Pro Microphone"), d("shure", "Shure MV7")];
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        enumerateDevices: async () => (granted ? inputs : inputs.map((i) => ({ ...i, label: "" }) as MediaDeviceInfo)),
        getUserMedia: async () => {
          granted = true;
          return { getTracks: () => [{ stop() {} }] };
        },
        addEventListener: (_: string, fn: () => void) => listeners.push(fn),
        removeEventListener: () => {},
      },
    });
  }
  afterEach(() => {
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
  });

  async function openMenu() {
    await act(async () => host.querySelector<HTMLButtonElement>(".voice-options")!.click());
    await flush();
  }
  const items = () => Array.from(host.querySelectorAll<HTMLButtonElement>(".voice-menu [role='menuitemradio'], .voice-menu [role='menuitem']"));
  const item = (label: RegExp) => items().find((b) => label.test(b.textContent ?? ""))!;

  it("before permission it offers to show the microphones; after, it lists them by name", async () => {
    stubDevices();
    await mount();
    await openMenu();
    expect(item(/Show my microphones/)).toBeTruthy();
    await act(async () => item(/Show my microphones/).click());
    await flush();
    expect(items().map((b) => b.textContent)).toEqual(expect.arrayContaining(["System default", "MacBook Pro Microphone", "Shure MV7"]));
    expect(items().some((b) => /Show my microphones/.test(b.textContent ?? ""))).toBe(false);
    expect(items().some((b) => /^Default - /.test(b.textContent ?? ""))).toBe(false);
  });

  it("the chosen microphone is remembered and recorded from", async () => {
    stubDevices();
    granted = true;
    await mount();
    await openMenu();
    expect(item(/System default/).getAttribute("aria-checked")).toBe("true");
    await act(async () => item(/Shure MV7/).click());
    expect(item(/Shure MV7/).getAttribute("aria-checked")).toBe("true");
    expect(window.localStorage.getItem("outfitter.voice.micId")).toBe("shure");
    await pointer("pointerdown");
    expect(deviceIds).toEqual(["shure"]);
  });

  it("follows the chosen mic by name when the browser issued new ids", async () => {
    stubDevices();
    granted = true;
    window.localStorage.setItem("outfitter.voice.micId", "old-id-from-before");
    window.localStorage.setItem("outfitter.voice.micLabel", "Shure MV7");
    await mount();
    await openMenu();
    expect(item(/Shure MV7/).getAttribute("aria-checked")).toBe("true");
    expect(window.localStorage.getItem("outfitter.voice.micId")).toBe("shure");
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await pointer("pointerdown");
    expect(deviceIds).toEqual(["shure"]);
  });

  it("a chosen mic that isn't connected shows as such", async () => {
    stubDevices();
    granted = true;
    window.localStorage.setItem("outfitter.voice.micId", "unplugged");
    window.localStorage.setItem("outfitter.voice.micLabel", "USB Headset");
    await mount();
    await openMenu();
    const row = item(/not connected/);
    expect(row.disabled).toBe(true);
    expect(row.getAttribute("aria-checked")).toBe("true");
  });

  it("arrow keys reach Show my microphones…", async () => {
    stubDevices();
    await mount();
    await openMenu();
    const menu = host.querySelector<HTMLElement>(".voice-menu")!;
    await act(async () => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    await act(async () => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      seen.add(document.activeElement?.textContent ?? "");
      await act(async () => menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    }
    expect([...seen].some((t) => /Show my microphones/.test(t))).toBe(true);
  });

  it("follows microphones being plugged in", async () => {
    stubDevices();
    granted = true;
    await mount();
    inputs = [...inputs, { kind: "audioinput", deviceId: "usb", label: "USB Headset", groupId: "g" } as MediaDeviceInfo];
    await act(async () => listeners.forEach((fn) => fn()));
    await flush();
    await openMenu();
    expect(item(/USB Headset/)).toBeTruthy();
  });

  it("says when the chosen microphone is gone and the default is recording", async () => {
    stubDevices();
    await mount();
    await pointer("pointerdown");
    await act(async () => runs[0].cb.onDeviceFallback?.());
    expect(host.querySelector(".voice-note")?.textContent).toMatch(/chosen microphone isn't connected/);
  });

  it("with built-in speech it says the system default is used", async () => {
    stubDevices();
    await mount({ voiceEngine: "builtin" });
    await openMenu();
    expect(host.querySelector(".voice-menu")?.textContent).toMatch(/built-in speech always uses the system default microphone/);
  });
});
