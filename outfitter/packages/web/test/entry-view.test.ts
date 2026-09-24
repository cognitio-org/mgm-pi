import { describe, it, expect } from "vitest";
import { entryToViews, entriesToViews, imageSrc } from "../src/lib/entry-view.ts";
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
          { type: "thinking", thinking: "hmm", thinkingSignature: "sig" },
          { type: "text", text: "here you go" },
          { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
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

  it("bug 5b: maps a thinking_level_change entry instead of falling back to 'unknown'", () => {
    const entry: PiEntry = { id: "e4b", parentId: "e4", type: "thinking_level_change", thinkingLevel: "high" };
    expect(entryToViews(entry)).toEqual([{ kind: "thinking-level-change", id: "e4b", thinkingLevel: "high" }]);
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

  it("keeps user text and adds images only when image blocks are present", () => {
    const entry: PiEntry = {
      id: "e-img",
      parentId: null,
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: "see this" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
          { type: "text", text: "and that" },
          { type: "image", data: "BBBB", mimeType: "image/jpeg" },
        ],
        timestamp: 1,
      },
    };
    expect(entryToViews(entry)).toEqual([
      {
        kind: "user",
        id: "e-img",
        text: "see this\nand that",
        images: [
          { mimeType: "image/png", data: "AAAA" },
          { mimeType: "image/jpeg", data: "BBBB" },
        ],
      },
    ]);
    expect(imageSrc({ mimeType: "image/jpeg", data: "abc" })).toBe("data:image/jpeg;base64,abc");
  });

  it("omits images when a user message has no image blocks", () => {
    const entry: PiEntry = {
      id: "e-txt",
      parentId: null,
      type: "message",
      message: {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
          { type: "image", data: 12, mimeType: "image/png" },
        ],
        timestamp: 1,
      },
    };
    const [view] = entryToViews(entry);
    expect(view).toEqual({ kind: "user", id: "e-txt", text: "a\nb" });
    expect(view).not.toHaveProperty("images");
  });

  it("does not attach image blocks on assistant messages", () => {
    const entry: PiEntry = {
      id: "e-asst",
      parentId: null,
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "hi" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
        timestamp: 1,
      },
    };
    expect(entryToViews(entry)).toEqual([{ kind: "assistant-text", id: "e-asst#0", text: "hi" }]);
  });

  it("a tool call with no arguments still maps (regression: the session page crashed on it)", () => {
    const entry = {
      type: "message",
      id: "e9",
      parentId: null,
      timestamp: "2026-09-22T00:00:00.000Z",
      message: { role: "assistant", content: [{ type: "toolCall", id: "tc9", name: "ls" }] },
    } as unknown as PiEntry;
    expect(entryToViews(entry)).toEqual([{ kind: "tool-call", id: "e9#0", toolName: "ls", toolCallId: "tc9", input: {} }]);
  });
});
