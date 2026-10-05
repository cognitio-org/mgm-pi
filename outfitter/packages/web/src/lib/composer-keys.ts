// Cloud-fixes 12: the composer's Enter-key behaviour, as a pure function so every combination is
// unit-testable without a DOM. Two modes, switchable in the composer and remembered per browser:
// - "send":    Enter sends, Shift+Enter inserts a newline (chat-app convention; desktop default);
// - "newline": Enter inserts a newline, Shift+Enter sends (a phone's on-screen Return key can't
//              hold Shift, so a stray Return there must never fire a half-written message).
// Cmd/Ctrl+Enter always sends, in either mode. Nothing fires mid-IME composition (a Japanese or
// Chinese input method uses Enter to commit the candidate, not to send).

import { isTouchDeviceHere } from "./touch.ts";

export type EnterMode = "send" | "newline";

export interface ComposerKeyEventLike {
  key: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** "send": preventDefault and send. "newline": leave the default (the textarea inserts a newline).
 * "ignore": not an Enter this function cares about. */
export type ComposerKeyAction = "send" | "newline" | "ignore";

export function composerKeyAction(e: ComposerKeyEventLike, mode: EnterMode): ComposerKeyAction {
  if (e.key !== "Enter") return "ignore";
  // keyCode 229 is what Safari reports for the Enter that commits an IME candidate, sometimes
  // without isComposing set.
  if (e.isComposing || e.keyCode === 229) return "ignore";
  if (e.metaKey || e.ctrlKey) return "send";
  if (e.altKey) return "newline";
  if (mode === "send") return e.shiftKey ? "newline" : "send";
  return e.shiftKey ? "send" : "newline";
}

export const ENTER_MODE_STORAGE_KEY = "outfitter.composer.enterMode";

export function defaultEnterMode(touch: boolean): EnterMode {
  return touch ? "newline" : "send";
}

/** The saved choice, else the device default. Storage can throw (private mode, blocked cookies). */
export function loadEnterMode(storage: Pick<Storage, "getItem"> | undefined = safeLocalStorage(), touch = isTouchDeviceHere()): EnterMode {
  try {
    const saved = storage?.getItem(ENTER_MODE_STORAGE_KEY);
    if (saved === "send" || saved === "newline") return saved;
  } catch {
    // unreadable storage: fall back to the device default
  }
  return defaultEnterMode(touch);
}

export function saveEnterMode(mode: EnterMode, storage: Pick<Storage, "setItem"> | undefined = safeLocalStorage()): void {
  try {
    storage?.setItem(ENTER_MODE_STORAGE_KEY, mode);
  } catch {
    // not persisted; the choice still holds for this page
  }
}

// The composer's "tall editor" preference: a roomier box for writing long messages, remembered per
// browser. Off by default so the conversation keeps the space until someone asks for it.
export const TALL_EDITOR_STORAGE_KEY = "outfitter.composer.tall";

export function loadTallEditor(storage: Pick<Storage, "getItem"> | undefined = safeLocalStorage()): boolean {
  try {
    return storage?.getItem(TALL_EDITOR_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveTallEditor(tall: boolean, storage: Pick<Storage, "setItem"> | undefined = safeLocalStorage()): void {
  try {
    storage?.setItem(TALL_EDITOR_STORAGE_KEY, tall ? "1" : "0");
  } catch {
    // not persisted; the choice still holds for this page
  }
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}
