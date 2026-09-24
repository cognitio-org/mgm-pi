// @vitest-environment jsdom
// jsdom does not lay out. Card height is a stubbed offsetHeight, and ResizeObserver is a stand-in.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TranscriptRail } from "../src/components/TranscriptRail.tsx";
import type { RailTool } from "../src/lib/beats.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

class RecordingResizeObserver {
  static all: RecordingResizeObserver[] = [];
  el: Element | null = null;
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    RecordingResizeObserver.all.push(this);
  }
  observe(el: Element) {
    this.el = el;
  }
  unobserve() {
    this.el = null;
  }
  disconnect() {
    this.el = null;
  }
  fire() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

const tool: RailTool = {
  kind: "tool",
  id: "call-1",
  toolName: "read",
  toolCallId: "call-1",
  input: { path: "notes.txt" },
  isError: false,
  running: true,
};

function glyphTop(): number {
  return window.innerHeight - 70;
}

function mount(item: RailTool = tool) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(<TranscriptRail items={[item]} />));
}

function setHeight(card: HTMLElement, height: number) {
  Object.defineProperty(card, "offsetHeight", { configurable: true, get: () => height });
}

beforeEach(() => {
  RecordingResizeObserver.all = [];
  vi.stubGlobal("ResizeObserver", RecordingResizeObserver);
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  })) as typeof window.matchMedia;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    callback(0);
    return 1;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("rail-glyph")) return new DOMRect(480, glyphTop(), 22, 16);
    return new DOMRect();
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("TranscriptRail card", () => {
  it("re-places an open card when its height changes without a new glyph", () => {
    expect(window.innerHeight).toBeGreaterThan(200);
    mount();
    const glyph = container!.querySelector<HTMLButtonElement>(".rail-glyph")!;
    act(() => glyph.click());
    const card = container!.querySelector<HTMLElement>(".rail-card")!;
    expect(RecordingResizeObserver.all).toHaveLength(1);
    expect(RecordingResizeObserver.all[0]!.el).toBe(card);
    expect(card.style.top).toBe(`${glyphTop()}px`);

    card.style.top = "3px";
    act(() => RecordingResizeObserver.all[0]!.fire());
    expect(card.style.top).toBe("3px");

    setHeight(card, window.innerHeight);
    act(() => RecordingResizeObserver.all[0]!.fire());
    expect(card.style.top).toBe("8px");

    act(() => {
      root!.render(<TranscriptRail items={[{ ...tool, running: false, output: `${"line\n".repeat(80)}done` }]} />);
    });
    const grown = container!.querySelector<HTMLElement>(".rail-card")!;
    expect(RecordingResizeObserver.all).toHaveLength(1);
    expect(RecordingResizeObserver.all[0]!.el).toBe(grown);
    setHeight(grown, 1);
    act(() => RecordingResizeObserver.all[0]!.fire());
    expect(grown.style.top).toBe(`${glyphTop()}px`);
  });

  it("does not close on Escape while a modal dialog is open", () => {
    mount();
    act(() => container!.querySelector<HTMLButtonElement>(".rail-glyph")!.click());
    expect(document.querySelector(".rail-card")).not.toBeNull();
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => document.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(document.querySelector(".rail-card")).not.toBeNull();
    modal.remove();
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(document.querySelector(".rail-card")).toBeNull();
  });
});
