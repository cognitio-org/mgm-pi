// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BeatView, StreamedThought, THOUGHT_BUBBLE_COLLAPSE_MS } from "../src/components/TranscriptRail.tsx";
import { ThoughtBubbleToggle } from "../src/components/ThoughtBubbleToggle.tsx";
import { groupBeats, type ToolsOnlyBeat } from "../src/lib/beats.ts";
import { groupThinkingBlocks } from "../src/lib/thinking.ts";
import { isThoughtBubbleEnabled, setThoughtBubbleEnabled } from "../src/lib/thought-bubble.ts";
import type { EntryView } from "../src/lib/entry-view.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function thinking(id: string, text: string): EntryView {
  return { kind: "assistant-thinking", id, text };
}

function toolsOnly(text: string): ToolsOnlyBeat {
  const beat = groupBeats(groupThinkingBlocks([thinking("t1", text)]))[0];
  if (!beat || beat.kind !== "tools-only") throw new Error("expected a tools-only beat");
  return beat;
}

function matchMedia(matchesReduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: matchesReduce && query.includes("reduce"),
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
}

function mount(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
}

beforeEach(() => {
  localStorage.clear();
  matchMedia(false);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

describe("thought bubble preference", () => {
  it("stays off until turned on", () => {
    expect(isThoughtBubbleEnabled()).toBe(false);
    setThoughtBubbleEnabled(true);
    expect(isThoughtBubbleEnabled()).toBe(true);
    setThoughtBubbleEnabled(false);
    expect(isThoughtBubbleEnabled()).toBe(false);
  });

  it("tells the session page the next value", () => {
    const onChange = vi.fn();
    mount(<ThoughtBubbleToggle on={false} onChange={onChange} />);
    const button = container!.querySelector("button")!;
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(button.getAttribute("aria-label")).toBe("Thoughts, live thinking off");
    act(() => button.click());
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("BeatView live thought", () => {
  it("shows the open thought in the conversation column and keeps the rail glyph", () => {
    const beat = toolsOnly("planning the edit");
    mount(<BeatView beat={beat} liveThinkingId={beat.rail[0]!.id} />);
    expect(container!.querySelector(".thought-bubble-body")?.textContent).toBe("planning the edit");
    expect(container!.querySelector(".rail-glyph.is-thinking")).not.toBeNull();
    expect(container!.querySelector(".thought-bubble")?.getAttribute("aria-label")).toBe("Thinking");
  });

  it("shows an ellipsis before the first words arrive", () => {
    const beat = toolsOnly("  ");
    mount(<BeatView beat={beat} liveThinkingId={beat.rail[0]!.id} />);
    expect(container!.querySelector(".thought-bubble-body")?.textContent).toBe("…");
  });

  it("leaves the column clear when no thought is open", () => {
    mount(<BeatView beat={toolsOnly("planning the edit")} />);
    expect(container!.querySelector(".thought-bubble")).toBeNull();
    expect(container!.querySelector(".rail-glyph.is-thinking")).not.toBeNull();
  });

  it("grows the same bubble as the thought streams", () => {
    const first = toolsOnly("plan");
    mount(<BeatView beat={first} liveThinkingId={first.rail[0]!.id} />);
    const longer = toolsOnly("planning the edit");
    act(() => root!.render(<BeatView beat={longer} liveThinkingId={longer.rail[0]!.id} />));
    expect(container!.querySelector(".thought-bubble-body")?.textContent).toBe("planning the edit");
    expect(container!.querySelector(".thought-bubble-slot")?.classList.contains("is-collapsing")).toBe(false);
  });

  it("shrinks the words from the same render that ends the round", () => {
    vi.useFakeTimers();
    const first = toolsOnly("plan");
    mount(<BeatView beat={first} liveThinkingId={first.rail[0]!.id} />);
    const longer = toolsOnly("planning the edit");
    act(() => root!.render(<BeatView beat={longer} />));
    expect(container!.querySelector(".thought-bubble-body")?.textContent).toBe("planning the edit");
    expect(container!.querySelector(".thought-bubble-slot")?.classList.contains("is-collapsing")).toBe(true);
  });

  it("shrinks the bubble into the rail glyph, then removes it", () => {
    vi.useFakeTimers();
    const beat = toolsOnly("planning the edit");
    mount(<BeatView beat={beat} liveThinkingId={beat.rail[0]!.id} />);
    act(() => root!.render(<BeatView beat={beat} />));
    expect(container!.querySelector(".thought-bubble-slot")?.classList.contains("is-collapsing")).toBe(true);
    expect(container!.querySelector(".rail-glyph.is-receiving")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(THOUGHT_BUBBLE_COLLAPSE_MS);
    });
    expect(container!.querySelector(".thought-bubble")).toBeNull();
    expect(container!.querySelector(".rail-glyph.is-thinking")).not.toBeNull();
    expect(container!.querySelector(".rail-glyph.is-receiving")).toBeNull();
  });

  it("shows a thought that has not been stored yet, then shrinks it when the round ends", () => {
    vi.useFakeTimers();
    mount(<StreamedThought text="planning" drop={false} />);
    expect(container!.querySelector(".thought-bubble-body")?.textContent).toBe("planning");
    act(() => root!.render(<StreamedThought text={null} drop={false} />));
    expect(container!.querySelector(".thought-bubble-body")?.textContent).toBe("planning");
    expect(container!.querySelector(".thought-bubble-slot")?.classList.contains("is-collapsing")).toBe(true);
  });

  it("drops a streamed thought when the transcript already has it", () => {
    mount(<StreamedThought text="planning" drop={false} />);
    act(() => root!.render(<StreamedThought text={null} drop />));
    expect(container!.querySelector(".thought-bubble")).toBeNull();
  });

  it("removes the bubble immediately when motion is reduced", () => {
    matchMedia(true);
    const beat = toolsOnly("planning the edit");
    mount(<BeatView beat={beat} liveThinkingId={beat.rail[0]!.id} />);
    act(() => root!.render(<BeatView beat={beat} />));
    expect(container!.querySelector(".thought-bubble")).toBeNull();
    expect(container!.querySelector(".rail-glyph.is-thinking")).not.toBeNull();
  });
});
