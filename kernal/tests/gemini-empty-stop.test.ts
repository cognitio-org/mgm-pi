/** Gemini thought-only STOP: continue twice, then stop asking, and log either way. */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makePi, makeCtx } from "./harness.ts";
import mod from "../.pi/extensions/kernal-gemini-stop/index.ts";
import { CONTINUE_INSTRUCTION, GEMINI_EMPTY_STOP_TYPE } from "../.pi/extensions/kernal-gemini-stop/lib.ts";

const THOUGHT = "SECRET-THOUGHT currently pinging the target API";
const INSTRUCTION = CONTINUE_INSTRUCTION;

function assistant(id: string, patch: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    model: "gemini-auto-agentic",
    stopReason: "stop",
    responseId: "resp-1",
    content: [{ type: "thinking", thinking: THOUGHT }],
    usage: { output: 37, reasoning: 37 },
    ...patch,
  };
}

function messageEntry(id: string, message: Record<string, unknown>) {
  return { type: "message", id, message };
}

function marker(id: string, attempt: number, kind: "custom_message" | "custom" = "custom_message") {
  const details = {
    attempt,
    responseId: "resp-old",
    outputTokens: 30,
    reasoningTokens: 30,
    model: "gemini-auto-agentic",
    action: "continue" as const,
  };
  if (kind === "custom") return { type: "custom", id, customType: GEMINI_EMPTY_STOP_TYPE, data: details };
  return { type: "custom_message", id, customType: GEMINI_EMPTY_STOP_TYPE, content: INSTRUCTION, display: false, details };
}

const user = (id: string) => messageEntry(id, { role: "user", content: "keep going" });
const thought = (id: string) => messageEntry(id, assistant(id));

describe("gemini empty stop", () => {
  let pi: ReturnType<typeof makePi>;
  let logged: string[];
  let error: typeof console.error;

  beforeEach(() => {
    pi = makePi();
    mod(pi as any);
    logged = [];
    error = console.error;
    console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  });
  afterEach(() => { console.error = error; });

  async function turn(message: Record<string, unknown>, entries: unknown[], extra: Record<string, unknown> = {}) {
    const ctx = makeCtx({ entries });
    return pi.emit("turn_end", {
      message,
      toolResults: [],
      messageEntryId: "current",
      entries: [],
      ...extra,
    }, ctx);
  }

  function parsedLog() {
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /^gemini-empty-stop /);
    assert.equal(logged[0]!.includes(THOUGHT), false);
    assert.equal(logged[0]!.includes(INSTRUCTION), false);
    return JSON.parse(logged[0]!.slice("gemini-empty-stop ".length));
  }

  test("continues a Gemini thought-only stop and logs the detection", async () => {
    const message = assistant("current");
    const result = await turn(message, [user("u1"), messageEntry("current", message)]);
    assert.equal(result.continue, true);
    assert.equal(result.entries.length, 1);
    const entry = result.entries[0];
    assert.equal(entry.type, "custom_message");
    assert.equal(entry.customType, GEMINI_EMPTY_STOP_TYPE);
    assert.equal(entry.display, false);
    assert.equal(entry.content, INSTRUCTION);
    assert.deepEqual(entry.details, {
      attempt: 1,
      responseId: "resp-1",
      outputTokens: 37,
      reasoningTokens: 37,
      model: "gemini-auto-agentic",
      action: "continue",
    });
    assert.deepEqual(parsedLog(), entry.details);
  });

  test("matches a Gemini model id regardless of case, including whitespace-only text", async () => {
    const message = assistant("current", {
      model: "GEMINI-2.5-flash",
      content: [{ type: "thinking", thinking: THOUGHT }, { type: "text", text: " \n\t" }],
      responseId: undefined,
      usage: { output: 0, reasoning: 0 },
    });
    const result = await turn(message, [user("u1"), messageEntry("current", message)]);
    assert.equal(result.continue, true);
    assert.equal(result.entries[0].details.attempt, 1);
    assert.equal(result.entries[0].details.model, "GEMINI-2.5-flash");
    assert.equal(result.entries[0].details.responseId, null);
    assert.equal(result.entries[0].details.outputTokens, 0);
  });

  test("does not match visible text, a tool call, error, aborted, length, tool results, or a non-Gemini model", async () => {
    const cases: Record<string, unknown>[] = [
      assistant("current", { content: [{ type: "text", text: "done" }] }),
      assistant("current", { content: "done" }),
      assistant("current", { content: [{ type: "thinking", thinking: THOUGHT }, { type: "toolCall", id: "c", name: "bash", arguments: {} }] }),
      assistant("current", { stopReason: "error" }),
      assistant("current", { stopReason: "aborted" }),
      assistant("current", { stopReason: "length" }),
      assistant("current", { stopReason: "toolUse" }),
      assistant("current", { model: "gpt-5.4", provider: "gemini" }),
      assistant("current", { model: "claude-haiku-4-5" }),
    ];
    for (const message of cases) {
      logged.length = 0;
      const result = await turn(message, [user("u1"), messageEntry("current", message)]);
      assert.equal(result, undefined, JSON.stringify({ model: message.model, stopReason: message.stopReason, content: message.content }));
      assert.deepEqual(logged, []);
    }
    logged.length = 0;
    const withResults = assistant("current");
    const result = await turn(withResults, [user("u1"), messageEntry("current", withResults)], { toolResults: [{ role: "toolResult" }] });
    assert.equal(result, undefined);
    assert.deepEqual(logged, []);
  });

  test("a second consecutive detection still continues", async () => {
    const message = assistant("current", { responseId: "resp-2", usage: { output: 156, reasoning: 101 } });
    const entries = [user("u1"), thought("a1"), marker("m1", 1), messageEntry("current", message)];
    const result = await turn(message, entries);
    assert.equal(result.continue, true);
    assert.equal(result.entries[0].details.attempt, 2);
    assert.equal(result.entries[0].details.action, "continue");
    assert.equal(result.entries[0].details.outputTokens, 156);
    assert.equal(result.entries[0].details.reasoningTokens, 101);
    assert.equal(parsedLog().action, "continue");
  });

  test("the third consecutive detection does not continue", async () => {
    const message = assistant("current");
    const entries = [
      user("u1"),
      thought("a1"),
      marker("m1", 1),
      thought("a2"),
      marker("m2", 2, "custom"),
      messageEntry("current", message),
    ];
    const prior = { type: "custom", customType: "other", data: { keep: true } };
    const result = await turn(message, entries, { entries: [prior] });
    assert.equal(result.continue, false);
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0], prior);
    const cap = result.entries[1];
    assert.equal(cap.type, "custom");
    assert.equal(cap.customType, GEMINI_EMPTY_STOP_TYPE);
    assert.equal(cap.content, undefined);
    assert.equal(cap.data.action, "capped");
    assert.equal(cap.data.attempt, 3);
    assert.equal(parsedLog().action, "capped");
  });

  test("visible text, a tool call, or a new user message starts the count over", async () => {
    const message = assistant("current");
    const answered = messageEntry("a-text", { role: "assistant", content: [{ type: "text", text: "here" }], stopReason: "stop" });
    const called = messageEntry("a-call", { role: "assistant", content: [{ type: "toolCall", id: "c", name: "bash", arguments: {} }] });
    const fresh = await turn(message, [user("u0"), thought("a1"), marker("m1", 1), answered, messageEntry("current", message)]);
    assert.equal(fresh.entries[0].details.attempt, 1);
    logged.length = 0;
    const afterCall = await turn(message, [user("u0"), marker("m1", 1), called, { type: "message", id: "tr", message: { role: "toolResult" } }, messageEntry("current", message)]);
    assert.equal(afterCall.entries[0].details.attempt, 1);
    logged.length = 0;
    const afterUser = await turn(message, [marker("old", 1), marker("old2", 2), user("u1"), thought("a1"), messageEntry("current", message)]);
    assert.equal(afterUser.entries[0].details.attempt, 1);
  });

  test("a thought-only assistant between markers does not reset the count", async () => {
    const message = assistant("current");
    const entries = [user("u1"), thought("a1"), marker("m1", 1), thought("a2"), marker("m2", 2), messageEntry("current", message)];
    const result = await turn(message, entries);
    assert.equal(result.continue, false);
    assert.equal(result.entries[0].data.action, "capped");
    assert.equal(result.entries[0].data.attempt, 3);
  });
});
