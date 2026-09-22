import { describe, it, expect } from "vitest";
import { filterModels } from "../src/lib/model-filter.ts";
import type { ModelRow } from "../src/api/client.ts";

function row(id: string): ModelRow {
  return { id, auto: false };
}

describe("filterModels", () => {
  const models = [row("litellm/claude-auto-llm"), row("litellm/gpt-5-mini"), row("litellm/local-qwen-mlx")];

  it("returns everything (up to the limit) for an empty query", () => {
    expect(filterModels(models, "")).toEqual(models);
  });

  it("matches a case-insensitive substring of the id", () => {
    expect(filterModels(models, "GPT")).toEqual([row("litellm/gpt-5-mini")]);
  });

  it("matches multiple rows", () => {
    expect(filterModels(models, "auto")).toEqual([row("litellm/claude-auto-llm")]);
    expect(filterModels(models, "litellm/")).toEqual(models);
  });

  it("no match is an empty list", () => {
    expect(filterModels(models, "nonexistent")).toEqual([]);
  });

  it("caps at the given limit", () => {
    const many = Array.from({ length: 10 }, (_, i) => row(`litellm/model-${i}`));
    expect(filterModels(many, "", 3)).toHaveLength(3);
  });
});
