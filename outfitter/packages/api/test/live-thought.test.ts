import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isAssistantMessageEntry, liveThoughtTextFromEvent } from "../src/live-thought.ts";

describe("liveThoughtTextFromEvent", () => {
  test("ignores events that are not a thinking update", () => {
    assert.equal(liveThoughtTextFromEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta" } }), null);
    assert.equal(liveThoughtTextFromEvent({ type: "agent_end" }), null);
    assert.equal(liveThoughtTextFromEvent({ type: "message_update" }), null);
  });

  test("joins the partial's thinking blocks, and is empty before any words", () => {
    assert.equal(
      liveThoughtTextFromEvent({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_start", partial: { content: [{ type: "thinking", thinking: "" }] } },
      }),
      "",
    );
    assert.equal(
      liveThoughtTextFromEvent({
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          delta: " edit",
          partial: { content: [{ type: "thinking", thinking: "plan" }, { type: "thinking", thinking: "the edit" }] },
        },
      }),
      "plan\n\nthe edit",
    );
  });

  test("an assistant message is the thought landing; a tool result is not", () => {
    assert.equal(isAssistantMessageEntry({ type: "message", message: { role: "assistant", content: [] } }), true);
    assert.equal(isAssistantMessageEntry({ type: "message", message: { role: "toolResult" } }), false);
    assert.equal(isAssistantMessageEntry({ type: "custom" }), false);
  });
});
