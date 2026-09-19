import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { letters, bannerLines, GLYPHS, NARROW_BELOW } from "../.pi/extensions/mgm-banner/lib.ts";

const id = (_c: string, t: string) => t;

describe("MGM banner", () => {
  test("glyphs are 5x5", () => {
    for (const [ch, rows] of Object.entries(GLYPHS)) {
      assert.equal(rows.length, 5, ch);
      for (const r of rows) assert.equal(r.length, 5, `${ch}: ${r}`);
    }
  });
  test("letters render three glyphs with two gaps, equal width rows", () => {
    const rows = letters(id);
    assert.equal(rows.length, 5);
    const widths = new Set(rows.map((r) => [...r].length));
    assert.equal(widths.size, 1);
    assert.equal([...rows[0]].length, 2 + 3 * 10 + 2 * 3);
    assert.ok(rows[0].includes("██      ██"), "M top row has two posts");
  });
  test("wide layout shows the block letters, tagline, providers and model", () => {
    const lines = bannerLines(id, { width: 120, version: "0.85.1", model: { provider: "litellm", id: "claude-sonnet-5" } });
    assert.ok(lines.some((l) => l.includes("██")));
    assert.ok(lines.some((l) => l.includes("mgm on pi v0.85.1")));
    assert.ok(lines.some((l) => l.includes("● litellm") && l.includes("○ lmstudio") && l.includes("○ openrouter")));
    assert.ok(lines.some((l) => l.includes("⇄ litellm/claude-sonnet-5")));
    assert.ok(lines.some((l) => l.includes("/connect  /model  /help")));
  });
  test("narrow layout drops the block letters and fits the width", () => {
    const width = NARROW_BELOW - 10;
    const lines = bannerLines(id, { width, version: "0.85.1", model: { provider: "lmstudio", id: "qwen/qwen3.6-35b-a3b" } });
    assert.ok(!lines.some((l) => l.includes("██")));
    assert.ok(lines.some((l) => l.includes("▌MGM▐")));
    assert.ok(lines.some((l) => l.includes("● lmstudio")));
  });
  test("no model selected is stated explicitly", () => {
    const lines = bannerLines(id, { width: 100, version: "x" });
    assert.ok(lines.some((l) => l.includes("no model — /connect")));
    assert.ok(!lines.some((l) => l.includes("●")));
  });
  test("painter receives theme colour names", () => {
    const seen = new Set<string>();
    bannerLines((c, t) => { seen.add(c); return t; }, { width: 100, version: "x", model: { provider: "openrouter", id: "m" } });
    for (const c of ["accent", "success", "dim", "muted", "text"]) assert.ok(seen.has(c), c);
  });
});
