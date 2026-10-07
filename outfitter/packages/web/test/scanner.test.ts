import { describe, expect, it } from "vitest";
import { PERIOD_MS, pulseAlpha, scannerFrame, scannerLayout } from "../src/lib/scanner.ts";
import { formatElapsed, formatTokens, toolVerb, turnOutputTokens, turnStartedAt } from "../src/lib/live-status.ts";
import type { PiEntry } from "../src/api/client.ts";

describe("scanner geometry", () => {
  it("fits 6px segments with 2px gaps, centred", () => {
    expect(scannerLayout(78)).toEqual({ count: 10, offset: 0, step: 8 });
    const wide = scannerLayout(800);
    expect(wide.count).toBe(100);
    expect(wide.offset).toBe(1);
    expect(scannerLayout(3).count).toBe(1);
  });

  it("the head eases from one end to the other and back", () => {
    expect(scannerFrame(50, 0).head).toBeCloseTo(0);
    expect(scannerFrame(50, PERIOD_MS / 2).head).toBeCloseTo(49);
    expect(scannerFrame(50, PERIOD_MS / 4).dir).toBe(1);
    expect(scannerFrame(50, (PERIOD_MS * 3) / 4).dir).toBe(-1);
    // eased: half way across at half a sweep, but slow off the ends (under a quarter at a quarter)
    expect(scannerFrame(50, PERIOD_MS / 4).head).toBeCloseTo(24.5);
    expect(scannerFrame(50, PERIOD_MS / 8).head).toBeLessThan(49 / 4);
  });

  it("the trail fades behind the head and never leaves the strip", () => {
    const frame = scannerFrame(50, PERIOD_MS / 4);
    const alphas = frame.trail.map((s) => s.alpha);
    expect(alphas[alphas.length - 1]).toBe(1);
    expect([...alphas].sort((a, b) => a - b)).toEqual(alphas);
    expect(frame.trail.every((s) => s.index >= 0 && s.index < 50)).toBe(true);
    expect(scannerFrame(50, 0).trail.every((s) => s.index >= 0)).toBe(true);
  });

  it("reduced motion pulses within a gentle range", () => {
    for (let t = 0; t < 3000; t += 100) {
      expect(pulseAlpha(t)).toBeGreaterThanOrEqual(0.1);
      expect(pulseAlpha(t)).toBeLessThanOrEqual(0.8);
    }
  });
});

describe("live status", () => {
  const entries: PiEntry[] = [
    { id: "u0", type: "message", timestamp: "2026-10-07T10:00:00.000Z", message: { role: "user", content: "a" } },
    { id: "a0", type: "message", message: { role: "assistant", content: [], usage: { output: 500 } } },
    { id: "u1", type: "message", timestamp: "2026-10-07T10:05:00.000Z", message: { role: "user", content: "b" } },
    { id: "a1", type: "message", message: { role: "assistant", content: [], usage: { output: 120 } } },
    { id: "a2", type: "message", message: { role: "assistant", content: [], usage: { output: 80 } } },
  ];

  it("the turn starts at the newest prompt, or a later send", () => {
    const at = Date.parse("2026-10-07T10:05:00.000Z");
    expect(turnStartedAt(entries)).toBe(at);
    expect(turnStartedAt(entries, at + 5000)).toBe(at + 5000);
    expect(turnStartedAt(entries, at - 5000)).toBe(at);
    expect(turnStartedAt([])).toBeUndefined();
  });

  it("counts output tokens since the newest prompt", () => {
    expect(turnOutputTokens(entries)).toBe(200);
  });

  it("words and numbers", () => {
    expect(toolVerb({ toolName: "bash", input: { command: "npm test" } })).toBe("Running npm test");
    expect(toolVerb({ toolName: "read", input: { path: "a.ts" } })).toBe("Reading a.ts");
    expect(toolVerb({ toolName: "mcp_thing", input: {} })).toBe("Using mcp_thing");
    expect(formatElapsed(48_900)).toBe("48s");
    expect(formatElapsed(125_000)).toBe("2m 05s");
    expect(formatTokens(840)).toBe("840");
    expect(formatTokens(18_400)).toBe("18.4k");
  });
});
