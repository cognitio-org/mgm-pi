import { describe, expect, it } from "vitest";
import { handleMenuKey } from "../src/easter/menu/menuNav.ts";

describe("KERNAL GAMES menu keyboard navigation", () => {
  it("ArrowRight/ArrowDown/Tab move focus forward, wrapping at the end", () => {
    expect(handleMenuKey("ArrowRight", false, 0, 2)).toEqual({ index: 1, action: null });
    expect(handleMenuKey("ArrowRight", false, 1, 2)).toEqual({ index: 0, action: null });
    expect(handleMenuKey("Tab", false, 0, 2)).toEqual({ index: 1, action: null });
    expect(handleMenuKey("ArrowDown", false, 0, 2)).toEqual({ index: 1, action: null });
  });

  it("ArrowLeft/ArrowUp move focus backward, wrapping at the start", () => {
    expect(handleMenuKey("ArrowLeft", false, 1, 2)).toEqual({ index: 0, action: null });
    expect(handleMenuKey("ArrowLeft", false, 0, 2)).toEqual({ index: 1, action: null });
    expect(handleMenuKey("ArrowUp", false, 0, 2)).toEqual({ index: 1, action: null });
  });

  it("Shift+Tab moves focus backward", () => {
    expect(handleMenuKey("Tab", true, 1, 2)).toEqual({ index: 0, action: null });
    expect(handleMenuKey("Tab", true, 0, 2)).toEqual({ index: 1, action: null });
  });

  it("Enter and Space activate the focused tile without moving focus", () => {
    expect(handleMenuKey("Enter", false, 1, 2)).toEqual({ index: 1, action: "activate" });
    expect(handleMenuKey(" ", false, 0, 2)).toEqual({ index: 0, action: "activate" });
  });

  it("Escape closes the menu", () => {
    expect(handleMenuKey("Escape", false, 1, 2)).toEqual({ index: 1, action: "close" });
  });

  it("an unrelated key is a no-op", () => {
    expect(handleMenuKey("q", false, 1, 2)).toEqual({ index: 1, action: null });
  });

  it("wraps correctly across more than two tiles", () => {
    expect(handleMenuKey("ArrowRight", false, 2, 3)).toEqual({ index: 0, action: null });
    expect(handleMenuKey("ArrowLeft", false, 0, 3)).toEqual({ index: 2, action: null });
  });
});
