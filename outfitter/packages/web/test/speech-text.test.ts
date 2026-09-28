// #255: what of a reply gets read aloud.
import { describe, expect, it } from "vitest";
import { prepareForSpeech, replyText, splitSentences } from "../src/lib/speech-text.ts";

describe("prepareForSpeech", () => {
  it("keeps the prose and says where code was", () => {
    const md = "I fixed the bug.\n\n```ts\nconst x = 1;\nfoo(x);\n```\n\nAll tests pass.";
    expect(prepareForSpeech(md)).toBe("I fixed the bug. (code omitted) All tests pass.");
  });
  it("reads link text, not URLs; drops images and bare URLs", () => {
    expect(prepareForSpeech("See [the PR](https://github.com/x/y/pull/1) and https://example.com/a. ![shot](a.png)")).toBe("See the PR and.");
  });
  it("keeps short inline code, replaces long or code-like inline code", () => {
    expect(prepareForSpeech("Run `npm test` then check `const a = {b: 1}`.")).toBe("Run npm test then check that.");
  });
  it("drops markdown punctuation: headings, emphasis, lists, quotes, tables, rules", () => {
    const md = "## Summary\n- **Fixed** the _login_ bug\n- Added a test\n> quoted\n| a | b |\n|---|---|\n---\nDone.";
    expect(prepareForSpeech(md)).toBe("Summary. Fixed the login bug. Added a test. quoted. Done.");
  });
  it("an all-code reply says nothing; an unterminated fence still counts as code", () => {
    expect(prepareForSpeech("```\nls -la\n```")).toBe("");
    expect(prepareForSpeech("Here:\n```js\nstill streaming")).toBe("Here: (code omitted)");
  });
  it("several code blocks in a row are one marker", () => {
    expect(prepareForSpeech("A.\n```\n1\n```\n```\n2\n```\nB.")).toBe("A. (code omitted) B.");
  });
});

describe("splitSentences", () => {
  it("splits on sentence ends and merges very short ones into the next", () => {
    expect(splitSentences("Done. I fixed the login bug. All forty-two tests pass!")).toEqual([
      "Done. I fixed the login bug.",
      "All forty-two tests pass!",
    ]);
  });
  it("breaks a very long sentence at a comma or space", () => {
    const long = "one, ".repeat(100) + "end.";
    const parts = splitSentences(long, 100);
    expect(parts.every((p) => p.length <= 101)).toBe(true);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(long.trim().replace(/\s+/g, " "));
  });
  it("text with no full stop is one sentence", () => {
    expect(splitSentences("no punctuation here at all")).toEqual(["no punctuation here at all"]);
  });
});

describe("replyText", () => {
  it("joins an assistant message's text blocks, skipping thinking and tool calls", () => {
    const entry = {
      type: "message",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "First." }, { type: "toolCall", name: "bash" }, { type: "text", text: "Second." }] },
    };
    expect(replyText(entry)).toBe("First.\n\nSecond.");
  });
  it("anything else is empty", () => {
    expect(replyText({ type: "message", message: { role: "user", content: "hi" } })).toBe("");
    expect(replyText({ type: "model_change" })).toBe("");
  });
});
