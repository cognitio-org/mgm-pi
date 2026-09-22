// Pure keyboard-navigation logic for the KERNAL GAMES menu, factored out of GameMenu.tsx so it can
// be unit tested without touching the DOM (see test/easter-menu-nav.test.ts). The menu is a single
// row of cartridge tiles: Left/Right/Arrow keys and Tab move focus and wrap, Enter/Space activates
// the focused tile, Escape closes the menu.

export interface MenuNavResult {
  /** New focused tile index, wrapped into [0, count). */
  index: number;
  /** "activate" if this keystroke should launch the focused tile's game, "close" if it should
   * close the menu, or null if it only moved focus (or was not a navigation key at all). */
  action: "activate" | "close" | null;
}

const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown", "Tab"]);
const PREV_KEYS = new Set(["ArrowLeft", "ArrowUp"]);
const ACTIVATE_KEYS = new Set(["Enter", " ", "Spacebar"]);

export function handleMenuKey(key: string, shiftKey: boolean, index: number, count: number): MenuNavResult {
  if (key === "Escape") return { index, action: "close" };
  if (ACTIVATE_KEYS.has(key)) return { index, action: "activate" };
  if (key === "Tab") {
    const delta = shiftKey ? -1 : 1;
    return { index: (index + delta + count) % count, action: null };
  }
  if (NEXT_KEYS.has(key)) return { index: (index + 1) % count, action: null };
  if (PREV_KEYS.has(key)) return { index: (index - 1 + count) % count, action: null };
  return { index, action: null };
}
