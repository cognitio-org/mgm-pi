import { describe, it, expect } from "vitest";
import { entryToViews, entriesToViews } from "../src/lib/entry-view.ts";
import type { PiEntry } from "../src/api/client.ts";

describe("entryToViews", () => {
  it("maps a user message entry", () => {
    const entry: PiEntry = {
      id: "e1",
      parentId: null,
      type: "message",
      message: { role: "user", content: "hello", timestamp: 1 },
    };
    expect(entryToViews(entry)).toEqual([{ kind: "user", id: "e1", text: "hello" }]);
  });

  it("splits an assistant message into one view per content block", () => {
    const entry: PiEntry = {
      id: "e2",
      parentId: "e1",
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: "hmm" },
          { type: "text", text: "here you go" },
          { type: "toolCall", toolCallId: "tc1", toolName: "bash", input: { command: "ls" } },
        ],
        timestamp: 2,
      },
    };
    expect(entryToViews(entry)).toEqual([
      { kind: "assistant-thinking", id: "e2#0", text: "hmm" },
      { kind: "assistant-text", id: "e2#1", text: "here you go" },
      { kind: "tool-call", id: "e2#2", toolName: "bash", toolCallId: "tc1", input: { command: "ls" } },
    ]);
  });

  it("maps a tool result message", () => {
    const entry: PiEntry = {
      id: "e3",
      parentId: "e2",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "tc1",
        toolName: "bash",
        content: [{ type: "text", text: "file1\nfile2" }],
        isError: false,
        timestamp: 3,
      },
    };
    expect(entryToViews(entry)).toEqual([
      { kind: "tool-result", id: "e3", toolName: "bash", toolCallId: "tc1", text: "file1\nfile2", isError: false },
    ]);
  });

  it("maps a model_change entry", () => {
    const entry: PiEntry = { id: "e4", parentId: "e3", type: "model_change", provider: "anthropic", modelId: "claude" };
    expect(entryToViews(entry)).toEqual([{ kind: "model-change", id: "e4", provider: "anthropic", modelId: "claude" }]);
  });

  it("falls back to 'unknown' for an unrecognized entry type", () => {
    const entry: PiEntry = { id: "e5", parentId: null, type: "something_new" };
    expect(entryToViews(entry)).toEqual([{ kind: "unknown", id: "e5", entryType: "something_new" }]);
  });

  it("flattens a list of entries in order via entriesToViews", () => {
    const entries: PiEntry[] = [
      { id: "e1", parentId: null, type: "message", message: { role: "user", content: "hi", timestamp: 1 } },
      { id: "e2", parentId: "e1", type: "label", targetId: "e1", label: "starred" },
    ];
    expect(entriesToViews(entries)).toEqual([
      { kind: "user", id: "e1", text: "hi" },
      { kind: "label", id: "e2", targetId: "e1", label: "starred" },
    ]);
  });
});
