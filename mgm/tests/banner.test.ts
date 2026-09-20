import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { letters, bannerLines, whoami, animationFrames, GLYPHS, NARROW_BELOW, REVEAL_STEPS, PULSE_FRAMES, PROFILES } from "../.pi/extensions/mgm-banner/lib.ts";

const id = (_c: string, t: string) => t;
const mgm = whoami({ MGM_USER: "mgm" });
const tej = whoami({ gitEmail: "matej@mgms.eu" });

describe("identity", () => {
  test("recognises Matthew and Matej from any hint, case-insensitively", () => {
    assert.equal(whoami({ gitEmail: "mgm@augmentcode.com" }).letters, "MGM");
    assert.equal(whoami({ githubLogin: "mgmonteleone" }).name, "Matthew");
    assert.equal(whoami({ osUser: "mgm" }).known, true);
    assert.deepEqual([tej.name, tej.letters, tej.known], ["Matej", "MATEK", true]);
    assert.equal(whoami({ githubLogin: "TEJ42000" }).letters, "MATEK");
    assert.equal(whoami({ MGM_USER: "Matej" }).letters, "MATEK");
    assert.ok(tej.tagline.includes("TEJ42000"));
  });
  test("MGM_USER wins over git identity; unknown users get initials and no animation", () => {
    assert.equal(whoami({ MGM_USER: "matej", gitEmail: "mgm@augmentcode.com" }).letters, "MATEK");
    const g = whoami({ MGM_USER: "Ana Kovač", gitEmail: "ana@example.com" });
    assert.deepEqual([g.name, g.letters, g.known], ["Ana Kovač", "ANA", false]);
    assert.equal(whoami({}).letters, "MGM", "no hints at all still renders something");
    assert.equal(animationFrames(g), 0);
    assert.equal(animationFrames(mgm), REVEAL_STEPS("MGM") + PULSE_FRAMES);
  });
});

describe("glyphs and letters", () => {
  test("every glyph is 5x5 and every profile's letters have glyphs", () => {
    for (const [ch, rows] of Object.entries(GLYPHS)) { assert.equal(rows.length, 5, ch); for (const r of rows) assert.equal(r.length, 5, `${ch}: ${r}`); }
    for (const p of PROFILES) for (const ch of p.identity.letters) assert.ok(GLYPHS[ch], ch);
    for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") assert.ok(GLYPHS[ch], ch);
  });
  test("rows are equal width; partial reveal shows only the first columns", () => {
    const full = letters(id, "MATEK", mgm.sweep);
    assert.equal(new Set(full.map((r) => [...r].length)).size, 1);
    assert.equal([...full[0]].length, 2 + 5 * 10 + 4 * 3);
    const none = letters(id, "MATEK", mgm.sweep, 0);
    assert.ok(none.every((r) => !r.includes("█")));
    const five = letters(id, "MATEK", mgm.sweep, 5);
    assert.ok(five[0].includes("██      ██") && !five[0].includes("██      ██     ██"), "only the M is revealed");
  });
});

describe("banner", () => {
  test("wide layout: letters, tagline, providers, model, hints", () => {
    const lines = bannerLines(id, { width: 120, version: "0.85.1", identity: tej, model: { provider: "litellm", id: "claude-sonnet-5" } });
    assert.ok(lines.some((l) => l.includes("██")));
    assert.ok(lines.some((l) => l.includes("welcome back, Matej") && l.includes("mgm on pi v0.85.1")));
    assert.ok(lines.some((l) => l.includes("● litellm") && l.includes("○ lmstudio") && l.includes("○ openrouter")));
    assert.ok(lines.some((l) => l.includes("⇄ litellm/claude-sonnet-5")));
    assert.ok(lines.some((l) => l.includes("/setup")));
  });
  test("narrow layout uses the compact form", () => {
    const lines = bannerLines(id, { width: NARROW_BELOW - 10, version: "x", identity: tej, model: { provider: "lmstudio", id: "q" } });
    assert.ok(!lines.some((l) => l.includes("██")) && lines.some((l) => l.includes("▌MATEK▐")));
  });
  test("animation: frames reveal progressively, pulse rotates colours, then static", () => {
    const at = (f: number) => bannerLines(id, { width: 120, version: "x", identity: tej, frame: f });
    const blocks = (ls: string[]) => ls.join("").split("█").length - 1;
    const counts = [0, 5, 12, 20, REVEAL_STEPS("MATEK")].map((f) => blocks(at(f)));
    for (let i = 1; i < counts.length; i++) assert.ok(counts[i] >= counts[i - 1], `reveal grows: ${counts}`);
    assert.equal(counts[0], 0);
    assert.equal(blocks(at(REVEAL_STEPS("MATEK"))), blocks(at(Infinity)), "fully revealed at the end of the reveal");
    const seen = new Set<string>();
    const paint = (c: string, t: string) => { if (t.includes("█")) seen.add(c); return t; };
    bannerLines(paint, { width: 120, version: "x", identity: tej, frame: REVEAL_STEPS("MATEK") + 2 });
    assert.ok(seen.size >= 2, "pulse uses several sweep colours");
    assert.deepEqual(at(Infinity), at(REVEAL_STEPS("MATEK") + PULSE_FRAMES), "static after the last frame");
    assert.equal(animationFrames(tej), 25 + PULSE_FRAMES);
  });
  test("no model selected is stated explicitly", () => {
    assert.ok(bannerLines(id, { width: 100, version: "x", identity: mgm }).some((l) => l.includes("no model — /connect")));
  });
});
