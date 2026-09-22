import { describe, expect, it } from "vitest";
import { isTouchDevice } from "../src/lib/touch.ts";

describe("isTouchDevice", () => {
  it("is true when the coarse-pointer media query matches", () => {
    expect(isTouchDevice({ matchMedia: () => ({ matches: true }) })).toBe(true);
  });

  it("is false when the media query doesn't match and there are no touch points", () => {
    expect(isTouchDevice({ matchMedia: () => ({ matches: false }), maxTouchPoints: 0 })).toBe(false);
  });

  it("falls back to maxTouchPoints when matchMedia is unavailable", () => {
    expect(isTouchDevice({ maxTouchPoints: 5 })).toBe(true);
    expect(isTouchDevice({ maxTouchPoints: 0 })).toBe(false);
  });

  it("falls back to maxTouchPoints when matchMedia throws", () => {
    expect(
      isTouchDevice({
        matchMedia: () => {
          throw new Error("nope");
        },
        maxTouchPoints: 2,
      }),
    ).toBe(true);
  });

  it("is false with no signals at all", () => {
    expect(isTouchDevice({})).toBe(false);
  });
});
