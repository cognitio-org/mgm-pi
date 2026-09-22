import { describe, expect, it } from "vitest";
import {
  groupThinkingBlocks,
  thinkingAccessibleLabel,
  thinkingPreview,
  thinkingWordCount,
  thinkingWordLabel,
} from "../src/lib/thinking.ts";
import type { EntryView } from "../src/lib/entry-view.ts";

describe("thinkingPreview", () => {
  it("returns short text unchanged", () => {
    expect(thinkingPreview("short thought")).toBe("short thought");
  });

  it("truncates past maxChars with an ellipsis", () => {
    const text = "a".repeat(100);
    const preview = thinkingPreview(text);
    expect(preview.length).toBe(81); // 80 chars + ellipsis
    expect(preview.endsWith("…")).toBe(true);
  });

  it("never adds an ellipsis to text that already fits exactly", () => {
    const text = "a".repeat(80);
    expect(thinkingPreview(text)).toBe(text);
  });

  it("collapses internal whitespace/newlines to single spaces", () => {
    expect(thinkingPreview("line one\n\nline   two")).toBe("line one line two");
  });

  it("trims leading/trailing whitespace", () => {
    expect(thinkingPreview("   padded   ")).toBe("padded");
  });
});

describe("thinkingWordCount / thinkingWordLabel", () => {
  it("counts words split on whitespace", () => {
    expect(thinkingWordCount("one two three")).toBe(3);
  });

  it("ignores repeated/leading/trailing whitespace", () => {
    expect(thinkingWordCount("  one   two  ")).toBe(2);
  });

  it("is 0 for empty or whitespace-only text", () => {
    expect(thinkingWordCount("")).toBe(0);
    expect(thinkingWordCount("   ")).toBe(0);
  });

  it("pluralizes the label correctly", () => {
    expect(thinkingWordLabel("one")).toBe("1 word");
    expect(thinkingWordLabel("one two")).toBe("2 words");
    expect(thinkingWordLabel("")).toBe("0 words");
  });
});

describe("thinkingAccessibleLabel", () => {
  it("reads 'Show thinking, N words' when collapsed", () => {
    expect(thinkingAccessibleLabel("one two three", false)).toBe("Show thinking, 3 words");
  });

  it("reads 'Hide thinking, N words' when expanded", () => {
    expect(thinkingAccessibleLabel("one two three", true)).toBe("Hide thinking, 3 words");
  });
});

describe("groupThinkingBlocks", () => {
  function user(id: string, text = "hi"): EntryView {
    return { kind: "user", id, text };
  }
  function thinking(id: string, text = "hmm"): EntryView {
    return { kind: "assistant-thinking", id, text };
  }
  function text(id: string, t = "ok"): EntryView {
    return { kind: "assistant-text", id, text: t };
  }

  it("passes non-thinking views through unchanged, in order", () => {
    const views = [user("1"), text("2")];
    expect(groupThinkingBlocks(views)).toEqual(views);
  });

  it("wraps a single thinking block in a one-block group", () => {
    const out = groupThinkingBlocks([user("1"), thinking("2", "hmm")]);
    expect(out).toEqual([user("1"), { kind: "thinking-group", id: "thinking-group:2", blocks: [{ id: "2", text: "hmm" }] }]);
  });

  it("groups consecutive thinking blocks between two visible messages into one group", () => {
    const out = groupThinkingBlocks([user("1"), thinking("2", "a"), thinking("3", "b"), thinking("4", "c"), text("5")]);
    expect(out).toEqual([
      user("1"),
      {
        kind: "thinking-group",
        id: "thinking-group:2",
        blocks: [
          { id: "2", text: "a" },
          { id: "3", text: "b" },
          { id: "4", text: "c" },
        ],
      },
      text("5"),
    ]);
  });

  it("starts a new group after a non-thinking view splits a run", () => {
    const out = groupThinkingBlocks([thinking("1"), text("2"), thinking("3")]);
    expect(out.map((v) => v.kind)).toEqual(["thinking-group", "assistant-text", "thinking-group"]);
  });

  it("flushes a trailing run with no following visible message", () => {
    const out = groupThinkingBlocks([user("1"), thinking("2"), thinking("3")]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ kind: "thinking-group", blocks: [{ id: "2" }, { id: "3" }] });
  });

  it("returns [] for [] and handles an all-thinking transcript", () => {
    expect(groupThinkingBlocks([])).toEqual([]);
    const out = groupThinkingBlocks([thinking("1"), thinking("2")]);
    expect(out).toHaveLength(1);
  });

  it("keeps a stable group id as more thinking blocks stream into the same run", () => {
    const before = groupThinkingBlocks([user("1"), thinking("2")]);
    const after = groupThinkingBlocks([user("1"), thinking("2"), thinking("3")]);
    expect((before[1] as { id: string }).id).toBe((after[1] as { id: string }).id);
  });
});
