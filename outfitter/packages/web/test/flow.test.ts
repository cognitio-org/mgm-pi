import { describe, expect, it } from "vitest";
import { buildFlow, entryIdOf, lastVsCodeToolId, liveThinkingId, runningTool, thinkingSeconds, type FlowItem } from "../src/lib/flow.ts";
import type { EntryView } from "../src/lib/entry-view.ts";
import { groupThinkingBlocks } from "../src/lib/thinking.ts";
import type { PiEntry } from "../src/api/client.ts";

const user = (id: string, text = "hi"): EntryView => ({ kind: "user", id, text });
const prose = (id: string, text = "ok"): EntryView => ({ kind: "assistant-text", id, text });
const think = (id: string, text = "hmm"): EntryView => ({ kind: "assistant-thinking", id, text });
const call = (id: string, toolCallId: string, toolName = "read", input: unknown = { path: id }): EntryView => ({ kind: "tool-call", id, toolName, toolCallId, input });
const result = (id: string, toolCallId: string, text = "out", isError = false, toolName = "read"): EntryView => ({
  kind: "tool-result",
  id,
  toolName,
  toolCallId,
  text,
  isError,
});

const flow = (views: EntryView[], runSettled = false) => buildFlow(groupThinkingBlocks(views), { runSettled });
const kinds = (items: FlowItem[]) => items.map((i) => i.kind);

describe("buildFlow", () => {
  it("keeps the order things happened in: thought, prose, tools, prose", () => {
    const items = flow([user("u"), think("a#0"), prose("a#1"), call("a#2", "c1", "bash", { command: "ls" }), result("r1", "c1", "x", false, "bash"), prose("b#0")]);
    expect(kinds(items)).toEqual(["user", "thinking", "prose", "tool", "prose"]);
    const tool = items[3] as Extract<FlowItem, { kind: "tool" }>;
    expect(tool.output).toBe("x");
    expect(tool.running).toBe(false);
  });

  it("folds two or more finished look-ups in a row, but not one, nor an error", () => {
    const items = flow([call("a#0", "c1"), result("r1", "c1"), call("a#1", "c2", "grep"), result("r2", "c2", "m", false, "grep"), prose("b#0"), call("c#0", "c3"), result("r3", "c3")]);
    expect(kinds(items)).toEqual(["lookups", "prose", "tool"]);
    const failed = flow([call("a#0", "c1"), result("r1", "c1", "ENOENT", true), call("a#1", "c2"), result("r2", "c2")]);
    expect(kinds(failed)).toEqual(["tool", "tool"]);
  });

  it("an unanswered call runs until the next prompt or a settled run", () => {
    const open = flow([user("u"), call("a#0", "c1", "bash")]);
    expect((open[1] as Extract<FlowItem, { kind: "tool" }>).running).toBe(true);
    const settled = flow([user("u"), call("a#0", "c1", "bash")], true);
    expect((settled[1] as Extract<FlowItem, { kind: "tool" }>).running).toBe(false);
    const next = flow([call("a#0", "c1", "bash"), user("u2")]);
    expect((next[0] as Extract<FlowItem, { kind: "tool" }>).running).toBe(false);
  });

  it("an interrupted call never runs, and an orphan result is filled in by a late call", () => {
    const cut: EntryView = { kind: "tool-call", id: "a#0", toolName: "bash", toolCallId: "c1", input: {}, interrupted: true };
    expect((flow([cut])[0] as Extract<FlowItem, { kind: "tool" }>).interrupted).toBe(true);
    const orphan = flow([result("r1", "c1", "out", false, "bash"), call("a#0", "c1", "bash", { command: "pwd" })]);
    expect(orphan).toHaveLength(1);
    expect((orphan[0] as Extract<FlowItem, { kind: "tool" }>).input).toEqual({ command: "pwd" });
  });

  it("passes system lines through and drops empty prose", () => {
    expect(kinds(flow([{ kind: "system", id: "s", text: "boot" }, prose("a#0", "  ")]))).toEqual(["passthrough"]);
  });
});

describe("flow helpers", () => {
  it("the live thought is the newest thinking with no prose after it", () => {
    const items = flow([user("u"), think("a#0"), call("a#1", "c1", "bash")]);
    expect(liveThinkingId(items, true)).toBe("thinking-group:a#0");
    expect(liveThinkingId(items, false)).toBeNull();
    expect(liveThinkingId(flow([think("a#0"), prose("a#1")]), true)).toBeNull();
  });

  it("finds the running tool and the newest VS Code call", () => {
    const items = flow([call("a#0", "c1", "vscode"), result("r1", "c1", "ok", false, "vscode"), call("b#0", "c2", "bash")]);
    expect(runningTool(items)?.toolCallId).toBe("c2");
    expect(lastVsCodeToolId(items)).toBe("a#0");
  });

  it("entryIdOf strips the block and the thinking-group prefix", () => {
    expect(entryIdOf("e1#2")).toBe("e1");
    expect(entryIdOf("thinking-group:e1#0")).toBe("e1");
    expect(entryIdOf("e2")).toBe("e2");
  });

  it("thinkingSeconds times a thinking reply from the entry before it", () => {
    const entries: PiEntry[] = [
      { id: "u", type: "message", timestamp: "2026-10-07T10:00:00.000Z", message: { role: "user", content: "hi" } },
      { id: "a", type: "message", timestamp: "2026-10-07T10:00:04.400Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }] } },
      { id: "b", type: "message", timestamp: "2026-10-07T10:00:09.000Z", message: { role: "assistant", content: [{ type: "text", text: "y" }] } },
    ];
    const secs = thinkingSeconds(entries);
    expect(secs.get("a")).toBe(4);
    expect(secs.has("b")).toBe(false);
    const items = buildFlow(groupThinkingBlocks([think("a#0")]), { seconds: secs });
    expect(items[0]).toMatchObject({ kind: "thinking", seconds: 4 });
  });
});
