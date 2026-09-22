import { describe, it, expect } from "vitest";
import { relativeTime } from "../src/lib/relative-time.ts";

describe("relativeTime", () => {
  const now = new Date("2026-09-21T12:00:00.000Z").getTime();

  it("returns 'just now' for very recent timestamps", () => {
    expect(relativeTime(new Date(now - 5_000).toISOString(), now)).toBe("just now");
  });

  it("formats minutes", () => {
    expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe("5m ago");
  });

  it("formats hours", () => {
    expect(relativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe("3h ago");
  });

  it("formats days", () => {
    expect(relativeTime(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe("2d ago");
  });

  it("falls back to a calendar date for old timestamps", () => {
    expect(relativeTime(new Date(now - 30 * 86_400_000).toISOString(), now)).toBe(
      new Date(now - 30 * 86_400_000).toISOString().slice(0, 10),
    );
  });

  it("handles invalid input by returning it unchanged", () => {
    expect(relativeTime("not-a-date", now)).toBe("not-a-date");
  });
});
