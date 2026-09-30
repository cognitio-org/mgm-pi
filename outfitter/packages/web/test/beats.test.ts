import { describe, expect, it } from "vitest";
import { collapseRail, groupBeats, liveThinkingItem, type AssistantBeat, type RailThinking, type RailTool, type ToolsOnlyBeat } from "../src/lib/beats.ts";
import type { GroupedEntry } from "../src/lib/thinking.ts";
import { groupThinkingBlocks } from "../src/lib/thinking.ts";
import type { EntryView } from "../src/lib/entry-view.ts";

function thinking(id: string, text = "hmm"): EntryView {
  return { kind: "assistant-thinking", id, text };
}

function text(id: string, prose = "ok"): EntryView {
  return { kind: "assistant-text", id, text: prose };
}

function call(id: string, toolCallId: string, toolName = "read", input: unknown = { path: id }): EntryView {
  return { kind: "tool-call", id, toolName, toolCallId, input };
}

function result(id: string, toolCallId: string, output = "out", isError = false, toolName = "read"): EntryView {
  return { kind: "tool-result", id, toolName, toolCallId, text: output, isError };
}

function ok(id: string): RailTool {
  return { kind: "tool", id, toolName: "read", toolCallId: id, input: {}, output: "x", isError: false, running: false };
}

function err(id: string): RailTool {
  return { kind: "tool", id, toolName: "bash", toolCallId: id, input: {}, output: "no", isError: true, running: false };
}

function running(id: string): RailTool {
  return { kind: "tool", id, toolName: "read", toolCallId: id, input: {}, isError: false, running: true };
}

function thought(id: string): RailThinking {
  return { kind: "thinking", id, blocks: [{ id, text: "hmm" }] };
}

describe("groupBeats", () => {
  it("closes a rail when assistant prose arrives", () => {
    const beats = groupBeats(
      groupThinkingBlocks([
        thinking("t1", "plan"),
        call("c1", "tc1"),
        result("r1", "tc1", "files"),
        text("a1", "done"),
        call("c2", "tc2"),
      ]),
    );
    expect(beats.map((beat) => beat.kind)).toEqual(["assistant", "tools-only"]);
    expect(beats[0]).toMatchObject({ kind: "assistant", id: "thinking-group:t1", prose: "done" });
    expect((beats[0] as AssistantBeat).rail.map((item) => item.kind)).toEqual(["thinking", "tool"]);
    expect((beats[0] as AssistantBeat).rail[1]).toMatchObject({ id: "c1", running: false, output: "files" });
    expect(beats[1]).toMatchObject({ kind: "tools-only", id: "c2" });
  });

  it("does not pull a tool that starts after prose back into that beat", () => {
    const beats = groupBeats(
      groupThinkingBlocks([text("a1", "looking"), call("c1", "tc"), result("r1", "tc", "out"), text("a2", "done")]),
    );
    expect(beats).toHaveLength(2);
    expect(beats[0]).toMatchObject({ kind: "assistant", id: "a1", prose: "looking", rail: [] });
    expect(beats[1]).toMatchObject({
      kind: "assistant",
      id: "c1",
      prose: "done",
      rail: [{ kind: "tool", id: "c1", running: false, output: "out" }],
    });
  });

  it("pairs a call with the result that shares its toolCallId", () => {
    const beats = groupBeats(
      groupThinkingBlocks([call("c1", "tc1", "bash", { command: "ls" }), result("r1", "tc1", "a\nb", false, "bash"), text("a1", "ok")]),
    );
    expect(beats).toHaveLength(1);
    expect((beats[0] as AssistantBeat).rail).toEqual([
      {
        kind: "tool",
        id: "c1",
        toolName: "bash",
        toolCallId: "tc1",
        input: { command: "ls" },
        output: "a\nb",
        isError: false,
        running: false,
      },
    ]);
  });

  it("fills a call that prose already closed when its result arrives later", () => {
    const beats = groupBeats(
      groupThinkingBlocks([call("c1", "tc1", "bash"), text("a1", "on it"), result("r1", "tc1", "done", false, "bash")]),
    );
    expect(beats).toHaveLength(1);
    expect((beats[0] as AssistantBeat).rail[0]).toMatchObject({
      id: "c1",
      running: false,
      output: "done",
      isError: false,
    });
  });

  it("keeps an error on the paired tool and an orphan result as its own item", () => {
    const beats = groupBeats(
      groupThinkingBlocks([call("c1", "tc1", "bash"), result("r1", "tc1", "fail", true, "bash"), result("r2", "missing", "nope", true, "read")]),
    );
    expect(beats).toHaveLength(1);
    expect((beats[0] as ToolsOnlyBeat).rail).toMatchObject([
      { id: "c1", isError: true, running: false, output: "fail" },
      { id: "r2", isError: true, running: false, output: "nope" },
    ]);
  });

  it("marks a call with no result as running", () => {
    const beats = groupBeats(groupThinkingBlocks([call("c1", "tc1", "read"), text("a1", "looking")]));
    expect(beats[0]).toMatchObject({
      kind: "assistant",
      rail: [{ kind: "tool", id: "c1", running: true, isError: false }],
    });
    expect((beats[0] as AssistantBeat).rail[0]).not.toHaveProperty("output");
  });

  it("emits a tools-only beat at the end of the list and before a user", () => {
    const atEnd = groupBeats(groupThinkingBlocks([text("a1", "first"), thinking("t1"), call("c1", "tc")]));
    expect(atEnd.map((beat) => beat.kind)).toEqual(["assistant", "tools-only"]);
    expect(atEnd[1]).toMatchObject({ id: "thinking-group:t1" });
    expect((atEnd[1] as ToolsOnlyBeat).rail).toHaveLength(2);

    const beforeUser = groupBeats([
      ...groupThinkingBlocks([call("c1", "tc")]),
      { kind: "user", id: "u1", text: "stop" },
    ]);
    expect(beforeUser.map((beat) => beat.kind)).toEqual(["tools-only", "user"]);
    expect((beforeUser[0] as ToolsOnlyBeat).rail[0]).toMatchObject({ id: "c1", running: false });
  });

  it("stops blinking once a later user message has started the next round", () => {
    const beats = groupBeats(
      groupThinkingBlocks([
        call("c1", "tc1", "bash"),
        text("a1", "I'll review it"),
        { kind: "user", id: "u2", text: "next" },
        call("c2", "tc2", "bash"),
      ]),
    );
    const first = beats[0] as AssistantBeat;
    expect(first.rail[0]).toMatchObject({ id: "c1", running: false });
    const second = beats[2] as ToolsOnlyBeat;
    expect(second.rail[0]).toMatchObject({ id: "c2", running: true });
  });

  it("fills a settled call when its result arrives after the next user message", () => {
    const beats = groupBeats(
      groupThinkingBlocks([
        call("c1", "tc1", "bash"),
        { kind: "user", id: "u2", text: "next" },
        result("r1", "tc1", "done", false, "bash"),
      ]),
    );
    expect((beats[0] as ToolsOnlyBeat).rail[0]).toMatchObject({ id: "c1", running: false, output: "done" });
    expect(beats.filter((beat) => beat.kind === "tools-only")).toHaveLength(1);
  });

  it("stops blinking when the run has settled, and keeps blinking while it is still working", () => {
    const views = groupThinkingBlocks([call("c1", "tc1", "bash"), text("a1", "on it")]);
    expect((groupBeats(views)[0] as AssistantBeat).rail[0]).toMatchObject({ running: true });
    expect((groupBeats(views, { runSettled: true })[0] as AssistantBeat).rail[0]).toMatchObject({ running: false });
  });

  it("passes user and system views through as their own beats", () => {
    const user: GroupedEntry = {
      kind: "user",
      id: "u1",
      text: "hi",
      images: [{ mimeType: "image/png", data: "aaa" }],
    };
    const system: GroupedEntry = { kind: "system", id: "s1", text: "note" };
    const model: GroupedEntry = { kind: "model-change", id: "m1", provider: "anthropic", modelId: "claude" };
    const beats = groupBeats([user, ...groupThinkingBlocks([thinking("t1", "hmm")]), system, model]);
    expect(beats.map((beat) => beat.kind)).toEqual(["user", "tools-only", "passthrough", "passthrough"]);
    expect(beats[0]).toEqual({ kind: "user", id: "u1", view: user });
    expect(beats[2]).toEqual({ kind: "passthrough", id: "s1", view: system });
    expect(beats[3]).toEqual({ kind: "passthrough", id: "m1", view: model });
  });

  it("keeps beat and tool ids stable as the run grows", () => {
    const before = groupBeats(groupThinkingBlocks([thinking("t1", "a"), call("c1", "tc")]));
    const after = groupBeats(
      groupThinkingBlocks([
        thinking("t1", "a"),
        thinking("t1b", "more"),
        call("c1", "tc"),
        result("r1", "tc", "out"),
        text("a1", "done"),
      ]),
    );
    expect(before[0]?.id).toBe("thinking-group:t1");
    expect(after[0]?.id).toBe(before[0]?.id);
    expect((before[0] as ToolsOnlyBeat).rail[1]).toMatchObject({ id: "c1", running: true });
    expect((after[0] as AssistantBeat).rail[1]).toMatchObject({ id: "c1", running: false, output: "out" });
  });
});

describe("liveThinkingItem", () => {
  function open(views: EntryView[], runLive = true) {
    return liveThinkingItem(groupBeats(groupThinkingBlocks(views)), runLive);
  }

  it("returns the trailing thought while the run is still running", () => {
    expect(open([thinking("t1", "planning the edit")])).toMatchObject({
      kind: "thinking",
      id: "thinking-group:t1",
      blocks: [{ id: "t1", text: "planning the edit" }],
    });
    expect(open([thinking("t1", "")])).toMatchObject({ id: "thinking-group:t1", blocks: [{ text: "" }] });
  });

  it("returns the latest thought when a tool already finished earlier in the turn", () => {
    const item = open([thinking("t1", "first"), call("c1", "tc"), result("r1", "tc", "out"), thinking("t2", "second")]);
    expect(item).toMatchObject({ id: "thinking-group:t2", blocks: [{ id: "t2", text: "second" }] });
  });

  it("returns nothing once prose or a tool follows, or the run is not running", () => {
    expect(open([thinking("t1"), text("a1", "done")])).toBeNull();
    expect(open([thinking("t1"), call("c1", "tc")])).toBeNull();
    expect(open([thinking("t1", "done thinking")], false)).toBeNull();
    expect(liveThinkingItem([], true)).toBeNull();
  });

  it("returns nothing when a later beat follows the thought", () => {
    const user: GroupedEntry = { kind: "user", id: "u1", text: "go on" };
    const beats = groupBeats([
      user,
      ...groupThinkingBlocks([thinking("t1", "hmm")]),
      { kind: "system", id: "s1", text: "note" },
    ]);
    expect(liveThinkingItem(beats, true)).toBeNull();
  });
});

describe("collapseRail", () => {
  it("keeps an error and a running call out of a 5-tool collapse", () => {
    const glyphs = collapseRail([err("e"), ok("1"), ok("2"), ok("3"), ok("4"), ok("5"), thought("t"), running("r")]);
    expect(glyphs.map((glyph) => glyph.kind)).toEqual(["single", "batch", "single", "single"]);
    expect(glyphs[0]).toMatchObject({ kind: "single", item: { id: "e", isError: true } });
    expect(glyphs[1]).toMatchObject({ kind: "batch", id: "1", tools: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }, { id: "5" }] });
    expect(glyphs[2]).toMatchObject({ kind: "single", item: { kind: "thinking", id: "t" } });
    expect(glyphs[3]).toMatchObject({ kind: "single", item: { id: "r", running: true } });

    const fourAndError = collapseRail([ok("1"), ok("2"), ok("3"), ok("4"), err("e")]);
    expect(fourAndError.every((glyph) => glyph.kind === "single")).toBe(true);
    expect(fourAndError).toHaveLength(5);

    const errorsOnly = collapseRail([err("1"), err("2"), err("3"), err("4"), err("5")]);
    expect(errorsOnly.every((glyph) => glyph.kind === "single")).toBe(true);
  });

  it("does not count thinking toward the collapse", () => {
    const four = collapseRail([ok("1"), thought("t1"), ok("2"), ok("3"), ok("4"), thought("t2")]);
    expect(four.every((glyph) => glyph.kind === "single")).toBe(true);
    expect(four).toHaveLength(6);

    const five = collapseRail([thought("t"), ok("1"), ok("2"), ok("3"), ok("4"), ok("5")]);
    expect(five.map((glyph) => glyph.kind)).toEqual(["single", "batch"]);
    expect(five[0]).toMatchObject({ item: { kind: "thinking" } });
    expect(five[1]).toMatchObject({ kind: "batch", tools: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }, { id: "5" }] });
  });
});
