import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { budgets, estimateText, maskOldToolResults, chunkMessages, summaryPrompt, shortenPrompt, wordBudget, pickSummarizer, statusText, ELIDED_MARK, type Msg } from "../.pi/extensions/compaction/lib.ts";

describe("budgets", () => {
  test("32k window: everything fits with headroom", () => {
    const b = budgets(32_768);
    assert.equal(b.small, true);
    assert.equal(b.keepRecentTokens, 8_192);
    assert.equal(b.summaryMaxTokens, 1_638);
    assert.equal(b.chunkTokens, 9_830);
    assert.equal(b.triggerPercent, 60);
    assert.equal(b.keepResults, 2);
    // after compaction: kept tail + summary must leave most of the window free
    assert.ok(b.keepRecentTokens + b.summaryMaxTokens < 32_768 * 0.35);
    // a summarization request (chunk + prompt + answer) must fit the same window
    assert.ok(b.chunkTokens + 1_000 + b.summaryMaxTokens < 32_768 * 0.6);
  });
  test("128k window (the declared LM Studio budget)", () => {
    const b = budgets(131_072);
    assert.equal(b.small, false);
    assert.equal(b.keepRecentTokens, 32_768);
    assert.equal(b.summaryMaxTokens, 3_000);
    assert.equal(b.chunkTokens, 39_322);
    assert.deepEqual([b.triggerPercent, b.keepResults, b.maskMinChars], [85, 8, 4_000]);
  });
  test("large windows are conservative and capped", () => {
    const b = budgets(1_000_000);
    assert.equal(b.small, false);
    assert.equal(b.keepRecentTokens, 40_000);
    assert.equal(b.summaryMaxTokens, 3_000);
    assert.equal(b.chunkTokens, 40_000);
    assert.equal(b.triggerPercent, 85);
  });
  test("unknown window falls back to pi's 128k assumption", () => {
    assert.equal(budgets(0).contextWindow, 128_000);
  });
});

const tool = (text: string, name = "read"): Msg => ({ role: "toolResult", toolName: name, toolCallId: "c", content: [{ type: "text", text }] });
const user = (t: string): Msg => ({ role: "user", content: [{ type: "text", text: t }] });
const asst = (t: string): Msg => ({ role: "assistant", content: [{ type: "text", text: t }, { type: "toolCall", id: "c", name: "read", arguments: {} }] });
const big = "x".repeat(5_000);

describe("observation masking", () => {
  const convo: Msg[] = [user("t1"), asst("a"), tool(big), tool(big, "bash"), asst("b"), tool(big), user("t2"), asst("c"), tool(big)];
  test("keeps the newest N results verbatim and masks older large ones, across turn boundaries", () => {
    const r = maskOldToolResults(convo, { keepResults: 2, minChars: 1_500 });
    assert.equal(r.masked, 2);
    assert.ok(r.savedChars > 8_000);
    const first = r.messages[2].content as any[];
    assert.ok(first[0].text.includes(ELIDED_MARK));
    assert.ok(first[0].text.startsWith("x".repeat(400)));
    assert.match(first[0].text, /4600 more chars of read output/);
    assert.match((r.messages[3].content as any[])[0].text, /bash output/);
    assert.equal((r.messages[5].content as any[])[0].text.length, 5_000, "2nd newest kept");
    assert.equal((r.messages[8].content as any[])[0].text.length, 5_000, "newest kept");
  });
  test("a single-turn read loop is pruned too", () => {
    const loop: Msg[] = [user("read everything"), asst("a"), tool(big), tool(big), tool(big), tool(big)];
    assert.equal(maskOldToolResults(loop, { keepResults: 2, minChars: 100 }).masked, 2);
  });
  test("small results, non-tool messages, fewer results than N, and already-masked results are untouched", () => {
    const small: Msg[] = [user("a"), asst("x"), tool("short"), user("b"), asst("y"), tool("short")];
    assert.equal(maskOldToolResults(small, { keepResults: 1, minChars: 100 }).masked, 0);
    assert.equal(maskOldToolResults([user("a"), asst("x"), tool(big)], { keepResults: 2, minChars: 100 }).masked, 0);
    const once = maskOldToolResults(convo, { keepResults: 1, minChars: 1_500 });
    const twice = maskOldToolResults(once.messages, { keepResults: 1, minChars: 1_500 });
    assert.equal(twice.masked, 0, "idempotent");
    assert.deepEqual(twice.messages, once.messages);
  });
  test("does not mutate the input", () => {
    const before = JSON.stringify(convo);
    maskOldToolResults(convo, { keepResults: 1, minChars: 100 });
    assert.equal(JSON.stringify(convo), before);
  });
  test("keeps image blocks and the tool identity", () => {
    const withImage: Msg = { ...tool(big), content: [{ type: "text", text: big }, { type: "image", data: "…" }] };
    const r = maskOldToolResults([withImage, tool("newer")], { keepResults: 1, minChars: 100 });
    const c = r.messages[0].content as any[];
    assert.equal(c.length, 2);
    assert.equal(c[1].type, "image");
    assert.equal(r.messages[0].toolCallId, "c");
  });
});

describe("chunking", () => {
  const est = (m: { n: number }) => m.n;
  const isTR = (m: { n: number; tr?: boolean }) => !!m.tr;
  test("splits by budget at non-tool-result boundaries", () => {
    const msgs = [{ n: 4 }, { n: 4 }, { n: 4, tr: true }, { n: 4 }, { n: 4 }];
    const chunks = chunkMessages(msgs, 10, est, isTR);
    assert.deepEqual(chunks.map((c) => c.length), [3, 2], "tool result stays with its call even over budget");
  });
  test("oversized single message gets its own chunk; empty input gives no chunks", () => {
    assert.deepEqual(chunkMessages([{ n: 50 }, { n: 1 }], 10, est, isTR).map((c) => c.length), [1, 1]);
    assert.deepEqual(chunkMessages([], 10, est, isTR), []);
  });
  test("total is preserved", () => {
    const msgs = Array.from({ length: 37 }, (_, i) => ({ n: (i % 5) + 1, tr: i % 3 === 2 }));
    const chunks = chunkMessages(msgs, 9, est, isTR);
    assert.equal(chunks.flat().length, 37);
    for (const c of chunks) assert.ok(!isTR(c[0]) || c === chunks[0]);
  });
});

describe("prompts", () => {
  test("first summary vs update carry the right wrappers and the word budget", () => {
    const first = summaryPrompt("[User]: hi", undefined, undefined, 500);
    assert.ok(first.includes("<conversation>") && !first.includes("<previous-summary>"));
    assert.ok(first.includes("up to 500 words") && first.includes("## Goal") && first.includes("<modified-files>"));
    const upd = summaryPrompt("[User]: more", "## Goal\nold", "focus on tests", 300);
    assert.ok(upd.includes("<previous-summary>\n## Goal\nold") && upd.includes("<new-messages>") && upd.includes("Additional focus: focus on tests"));
  });
  test("shorten prompt and word budget", () => {
    assert.ok(shortenPrompt("partial", 200).includes("under 200 words") && shortenPrompt("partial", 200).endsWith("partial"));
    assert.equal(wordBudget(1_638), 900);
    assert.equal(wordBudget(100), 150, "floor");
  });
  test("estimateText mirrors chars/4", () => { assert.equal(estimateText("abcdefgh"), 2); assert.equal(estimateText("abcde"), 2); });
});

describe("summarizer selection", () => {
  const cur = { provider: "lmstudio", id: "qwen", contextWindow: 32_768 };
  const cloud = { provider: "litellm", id: "claude-haiku-4-5", contextWindow: 200_000 };
  const find = (p: string, id: string) => (p === cloud.provider && id === cloud.id ? cloud : undefined);
  test("uses the configured cloud model when found and authenticated", () => {
    assert.deepEqual(pickSummarizer(cur, "litellm/claude-haiku-4-5", find, () => true), { model: cloud, reason: "configured summarizer" });
  });
  test("falls back to the current model with a reason", () => {
    assert.equal(pickSummarizer(cur, "litellm/claude-haiku-4-5", find, () => false).reason, "litellm/claude-haiku-4-5 has no credentials");
    assert.equal(pickSummarizer(cur, "litellm/nope", find, () => true).reason, "litellm/nope not found");
    assert.equal(pickSummarizer(cur, undefined, find, () => true).model, cur);
    assert.equal(pickSummarizer(cur, "garbage", find, () => true).model, cur);
  });
});

describe("status", () => {
  test("footer text", () => {
    assert.equal(statusText(62.4, 0, true), "◔ ctx 62%");
    assert.equal(statusText(12, 3, false), "◕ ctx 12% · 3 pruned");
    assert.equal(statusText(null, 0, true), "◔ ctx ?");
  });
});

describe("pinned content", async () => {
  const { collectPins, pinnedBlock, composeSummary, stripPinned } = await import("../.pi/extensions/compaction/lib.ts");
  const entries = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "Refactor the auth module" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    { type: "custom_message", customType: "pi-memory", content: "remember: use pnpm" },
    { type: "custom", customType: "kernal-pin", data: { text: "API base is https://x/v1" } },
    { type: "custom_message", customType: "compaction", content: "old summary" },
    { type: "message", message: { role: "user", content: "later question" } },
    { type: "custom", customType: "kernal-pin", data: { text: "in kept tail, not collected" } },
  ];
  test("collects the original request, extension messages and pins before the kept tail", () => {
    const pins = collectPins(entries, 5);
    assert.deepEqual(pins, [
      { label: "original request", text: "Refactor the auth module" },
      { label: "pi-memory", text: "remember: use pnpm" },
      { label: "pinned", text: "API base is https://x/v1" },
    ]);
    assert.equal(collectPins([], 0).length, 0);
    assert.match(collectPins([{ type: "message", message: { role: "user", content: "x".repeat(5000) } }], 1)[0].text, /…\[truncated\]$/);
  });
  test("compose and strip round-trip so the model never sees the block", () => {
    const pins = collectPins(entries, 5);
    const full = composeSummary(pins, "## Goal\nrefactor");
    assert.ok(full.startsWith("<pinned-context>\n[original request]\nRefactor the auth module"));
    assert.ok(full.endsWith("</pinned-context>\n\n## Goal\nrefactor"));
    assert.equal(stripPinned(full), "## Goal\nrefactor");
    assert.equal(stripPinned("plain"), "plain");
    assert.equal(stripPinned(undefined), undefined);
    assert.equal(stripPinned(pinnedBlock(pins)), undefined, "block-only summary strips to nothing");
    assert.equal(composeSummary([], "s"), "s");
  });
});

describe("profiles and preferences", async () => {
  const { detectProfile, effective, rankSummarizers, PROFILE_TUNING } = await import("../.pi/extensions/compaction/lib.ts");
  const call = (name: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "x", name, arguments: {} }] } });
  test("detects code vs research vs chat from tool calls", () => {
    assert.equal(detectProfile([call("read"), call("edit"), call("web_search")]).profile, "code");
    assert.equal(detectProfile([call("web_search"), call("fetch_content"), call("read")]).profile, "research");
    assert.equal(detectProfile([]).profile, "chat");
    assert.deepEqual(detectProfile([call("read"), call("mcp"), call("unknown_tool")]), { profile: "code", code: 1, research: 1, total: 3 });
  });
  test("profile tuning then user overrides", () => {
    const b = budgets(32_768);
    const code = effective(b, "code", {});
    assert.equal(code.keepResults, 2); assert.equal(code.maskMinChars, 1_500); assert.equal(code.masking, true); assert.equal(code.summaryWords, 900);
    const research = effective(b, "research", {});
    assert.equal(research.keepResults, 4); assert.equal(research.maskMinChars, 3_000);
    const chat = effective(b, "chat", {});
    assert.equal(chat.keepResults, 1, "never below 1"); assert.equal(chat.maskMinChars, 750);
    const custom = effective(b, "code", { keepResults: 6, triggerPercent: 40, masking: false, summaryWords: 400 });
    assert.deepEqual([custom.keepResults, custom.triggerPercent, custom.masking, custom.summaryWords, custom.profile], [6, 40, false, 400, "code"]);
    assert.ok(custom.focus === PROFILE_TUNING.code.focus);
  });
  test("summarizer ranking is cheapest first, filtered by window, with $/fold labels", () => {
    const r = rankSummarizers([
      { provider: "litellm", id: "claude-haiku-4-5", contextWindow: 200_000, cost: { input: 1, output: 5 } },
      { provider: "litellm", id: "gpt-5.4-nano", contextWindow: 272_000, cost: { input: 0.2, output: 1.25 } },
      { provider: "lmstudio", id: "qwen", contextWindow: 131_072, cost: { input: 0, output: 0 } },
      { provider: "tiny", id: "m", contextWindow: 8_000, cost: { input: 0, output: 0 } },
    ]);
    assert.deepEqual(r.map((x) => x.key), ["lmstudio/qwen", "litellm/gpt-5.4-nano", "litellm/claude-haiku-4-5"]);
    assert.match(r[1].label, /\$0\.0039\/fold, 272k ctx/);
    assert.match(r[0].label, /free, 131k ctx/);
  });
});
