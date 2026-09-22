import { describe, it, expect } from "vitest";
import { deriveSessionHeader } from "../src/lib/session-header.ts";
import type { PiEntry } from "../src/api/client.ts";

describe("deriveSessionHeader", () => {
  it("returns nothing for an empty transcript", () => {
    expect(deriveSessionHeader([])).toEqual({ model: undefined, thinking: undefined, context: undefined });
  });

  it("model from a model_change entry", () => {
    const entries: PiEntry[] = [{ id: "1", type: "model_change", provider: "litellm", modelId: "claude-auto-llm" }];
    expect(deriveSessionHeader(entries).model).toBe("litellm/claude-auto-llm");
  });

  it("model from the newest assistant message when no model_change entry follows it", () => {
    const entries: PiEntry[] = [
      { id: "1", type: "model_change", provider: "litellm", modelId: "old-model" },
      { id: "2", type: "message", message: { role: "assistant", provider: "litellm", model: "new-model", content: [] } },
    ];
    expect(deriveSessionHeader(entries).model).toBe("litellm/new-model");
  });

  it("a later model_change wins over an earlier assistant message", () => {
    const entries: PiEntry[] = [
      { id: "1", type: "message", message: { role: "assistant", provider: "litellm", model: "a", content: [] } },
      { id: "2", type: "model_change", provider: "litellm", modelId: "b" },
    ];
    expect(deriveSessionHeader(entries).model).toBe("litellm/b");
  });

  it("thinking from the newest thinking_level_change entry", () => {
    const entries: PiEntry[] = [
      { id: "1", type: "thinking_level_change", thinkingLevel: "low" },
      { id: "2", type: "thinking_level_change", thinkingLevel: "high" },
    ];
    expect(deriveSessionHeader(entries).thinking).toBe("high");
  });

  it("context tokens from the newest assistant message's usage: totalTokens preferred, else the sum", () => {
    const entries: PiEntry[] = [
      {
        id: "1",
        type: "message",
        message: { role: "assistant", content: [], usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 } },
      },
      {
        id: "2",
        type: "message",
        message: { role: "assistant", content: [], usage: { totalTokens: 999, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
      },
    ];
    expect(deriveSessionHeader(entries).context?.tokens).toBe(999);
  });

  it("sums components when totalTokens is absent", () => {
    const entries: PiEntry[] = [
      { id: "1", type: "message", message: { role: "assistant", content: [], usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 } } },
    ];
    expect(deriveSessionHeader(entries).context?.tokens).toBe(165);
  });

  it("skips aborted/error assistant turns and a zero usage never overwrites a prior good reading", () => {
    const entries: PiEntry[] = [
      { id: "1", type: "message", message: { role: "assistant", content: [], usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } } },
      { id: "2", type: "message", message: { role: "assistant", content: [], stopReason: "aborted", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } },
      { id: "3", type: "message", message: { role: "assistant", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } },
    ];
    expect(deriveSessionHeader(entries).context?.tokens).toBe(150);
  });

  it("ignores non-assistant messages entirely", () => {
    const entries: PiEntry[] = [{ id: "1", type: "message", message: { role: "user", content: "hi" } }];
    const info = deriveSessionHeader(entries);
    expect(info.model).toBeUndefined();
    expect(info.context).toBeUndefined();
  });

  it("computes percent and carries the window when a lookup is provided", () => {
    const entries: PiEntry[] = [
      { id: "1", type: "model_change", provider: "litellm", modelId: "claude-auto-llm" },
      { id: "2", type: "message", message: { role: "assistant", content: [], usage: { totalTokens: 50000, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } },
    ];
    const info = deriveSessionHeader(entries, (id) => (id === "litellm/claude-auto-llm" ? 200000 : undefined));
    expect(info.context).toEqual({ tokens: 50000, window: 200000, percent: 25 });
  });

  it("omits window/percent when the lookup has nothing for the model", () => {
    const entries: PiEntry[] = [
      { id: "1", type: "model_change", provider: "litellm", modelId: "unknown-model" },
      { id: "2", type: "message", message: { role: "assistant", content: [], usage: { totalTokens: 100, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } },
    ];
    const info = deriveSessionHeader(entries, () => undefined);
    expect(info.context).toEqual({ tokens: 100 });
  });
});
