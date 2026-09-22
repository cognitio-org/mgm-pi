import { describe, expect, it } from "vitest";
import { deriveDeskStatus, moveGridFocus, stoppedSessionCount } from "../src/lib/desk.ts";
import type { ProviderRow, SessionSummary } from "../src/api/client.ts";

function session(partial: Partial<SessionSummary>): SessionSummary {
  return {
    id: "s1",
    status: "open",
    guru: "g1",
    repo: null,
    cost: 0,
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

function provider(partial: Partial<ProviderRow>): ProviderRow {
  return {
    id: "p1",
    kind: "litellm",
    name: "LiteLLM",
    status: "up",
    checkedAt: new Date().toISOString(),
    ...partial,
  };
}

describe("deriveDeskStatus", () => {
  const now = new Date("2026-09-22T12:00:00Z");

  it("counts running/queued/provisioning sessions as running", () => {
    const sessions = [
      session({ id: "a", runState: "running", updatedAt: now.toISOString() }),
      session({ id: "b", runState: "queued", updatedAt: now.toISOString() }),
      session({ id: "c", runState: "idle", updatedAt: now.toISOString() }),
      session({ id: "d", runState: "stopped", updatedAt: now.toISOString() }),
    ];
    const status = deriveDeskStatus(sessions, [], now);
    expect(status.sessionCount).toBe(4);
    expect(status.runningCount).toBe(2);
  });

  it("sums cost only for sessions updated today", () => {
    const sessions = [
      session({ id: "a", cost: 1.5, updatedAt: now.toISOString() }),
      session({ id: "b", cost: 2.25, updatedAt: "2026-09-21T12:00:00Z" }),
    ];
    const status = deriveDeskStatus(sessions, [], now);
    expect(status.todaysCost).toBeCloseTo(1.5);
  });

  it("counts providers up out of total", () => {
    const providers = [provider({ status: "up" }), provider({ id: "p2", status: "down" }), provider({ id: "p3", status: "up" })];
    const status = deriveDeskStatus([], providers, now);
    expect(status.providersUp).toBe(2);
    expect(status.providersTotal).toBe(3);
  });
});

describe("stoppedSessionCount", () => {
  it("counts stopped and failed sessions only", () => {
    const sessions = [
      session({ id: "a", runState: "stopped" }),
      session({ id: "b", runState: "failed" }),
      session({ id: "c", runState: "running" }),
      session({ id: "d", runState: "idle" }),
    ];
    expect(stoppedSessionCount(sessions)).toBe(2);
  });
});

describe("moveGridFocus", () => {
  // 3-column grid, 7 items:
  // 0 1 2
  // 3 4 5
  // 6
  it("moves right and stops at the end", () => {
    expect(moveGridFocus(0, "ArrowRight", 7, 3)).toBe(1);
    expect(moveGridFocus(6, "ArrowRight", 7, 3)).toBe(6);
  });

  it("moves left and stops at the start", () => {
    expect(moveGridFocus(1, "ArrowLeft", 7, 3)).toBe(0);
    expect(moveGridFocus(0, "ArrowLeft", 7, 3)).toBe(0);
  });

  it("moves down a row when the target exists", () => {
    expect(moveGridFocus(0, "ArrowDown", 7, 3)).toBe(3);
    expect(moveGridFocus(1, "ArrowDown", 7, 3)).toBe(4);
  });

  it("does not move down past a short last row", () => {
    // index 4 + 3 = 7, out of range (count=7, max index 6) -- stays put
    expect(moveGridFocus(4, "ArrowDown", 7, 3)).toBe(4);
  });

  it("moves up a row, clamping into a short row above if needed", () => {
    expect(moveGridFocus(3, "ArrowUp", 7, 3)).toBe(0);
    expect(moveGridFocus(6, "ArrowUp", 7, 3)).toBe(3);
  });

  it("Home/End jump to the first/last item", () => {
    expect(moveGridFocus(4, "Home", 7, 3)).toBe(0);
    expect(moveGridFocus(1, "End", 7, 3)).toBe(6);
  });

  it("is a no-op on an empty grid", () => {
    expect(moveGridFocus(0, "ArrowRight", 0, 3)).toBe(0);
  });
});
