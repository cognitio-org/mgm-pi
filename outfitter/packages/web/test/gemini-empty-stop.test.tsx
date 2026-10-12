// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { PiEntry } from "../src/api/client.ts";
import { EntryItem } from "../src/components/EntryItem.tsx";
import { entryToViews, entriesToViews } from "../src/lib/entry-view.ts";
import { buildFlow } from "../src/lib/flow.ts";
import { groupThinkingBlocks } from "../src/lib/thinking.ts";
import {
  GEMINI_EMPTY_STOP_CAPPED,
  GEMINI_EMPTY_STOP_CONTINUE,
  GEMINI_EMPTY_STOP_TYPE,
} from "../src/lib/gemini-empty-stop.ts";

const INSTRUCTION = "You stopped after a thought and sent no reply. Call the next tool or write the reply.";

const continueEntry: PiEntry = {
  id: "m1",
  type: "custom_message",
  customType: GEMINI_EMPTY_STOP_TYPE,
  content: INSTRUCTION,
  display: false,
  details: { attempt: 1, action: "continue", model: "gemini-auto-agentic" },
};

const cappedEntry: PiEntry = {
  id: "m3",
  type: "custom",
  customType: GEMINI_EMPTY_STOP_TYPE,
  data: { attempt: 3, action: "capped", model: "gemini-auto-agentic" },
};

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function mount(node: React.ReactNode): HTMLElement {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}

describe("gemini empty stop note", () => {
  it("renders the continue note and does not leak the model instruction", () => {
    const views = entryToViews(continueEntry);
    expect(views).toEqual([
      { kind: "custom", id: "m1", customType: GEMINI_EMPTY_STOP_TYPE, text: GEMINI_EMPTY_STOP_CONTINUE },
    ]);
    const view = views[0]!;
    if (view.kind !== "custom") throw new Error("expected a custom note");
    const el = mount(<EntryItem view={view} />);
    const note = el.querySelector(".gemini-empty-stop");
    expect(note?.textContent).toBe(GEMINI_EMPTY_STOP_CONTINUE);
    expect(el.textContent).not.toContain(INSTRUCTION);
    expect(el.textContent).not.toContain("custom:");
  });

  it("renders the capped note from a plain custom entry", () => {
    const views = entryToViews(cappedEntry);
    expect(views).toEqual([
      { kind: "custom", id: "m3", customType: GEMINI_EMPTY_STOP_TYPE, text: GEMINI_EMPTY_STOP_CAPPED },
    ]);
    const view = views[0]!;
    if (view.kind !== "custom") throw new Error("expected a custom note");
    const el = mount(<EntryItem view={view} />);
    expect(el.querySelector(".gemini-empty-stop")?.textContent).toBe(GEMINI_EMPTY_STOP_CAPPED);
    expect(el.textContent).not.toContain(INSTRUCTION);
  });

  it("leaves a normal custom_message as a system line, including when display is false", () => {
    const entry: PiEntry = {
      id: "job",
      type: "custom_message",
      customType: "kernal-background",
      content: "job finished",
      display: false,
    };
    expect(entryToViews(entry)).toEqual([{ kind: "system", id: "job", text: "job finished" }]);
  });

  it("sits in the conversation column as its own note, not as an assistant reply", () => {
    const thought: PiEntry = {
      id: "a1",
      type: "message",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "thinking", thinking: "still pinging" }],
      },
    };
    const items = buildFlow(groupThinkingBlocks(entriesToViews([thought, continueEntry])));
    expect(items.map((b) => b.kind)).toEqual(["thinking", "passthrough"]);
    const note = items[1];
    expect(note?.kind).toBe("passthrough");
    if (note?.kind === "passthrough") {
      expect(note.view).toMatchObject({ kind: "custom", text: GEMINI_EMPTY_STOP_CONTINUE });
    }
  });
});
