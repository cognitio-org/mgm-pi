// Pure logic behind the easter egg's triggers (Konami code, typed `SYS 64738`, double-clicking the
// desk Trash), kept framework-free so it's unit-tested without a DOM (test/easter-triggers.test.ts).
// The React/DOM glue lives in useKonamiCode.ts, useSysCommand.ts and DeskPage.tsx. None of this
// imports the games: every trigger ends in openEasterEgg(), which dynamic-imports them.

/** True for elements where keystrokes are real typing: inputs, textareas, selects, contenteditable. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // isContentEditable, with an attribute fallback for DOMs that don't implement it (jsdom)
  return target.isContentEditable === true || target.closest('[contenteditable=""], [contenteditable="true"]') !== null;
}

/** The C64's reset vector: typing this at the READY. prompt rebooted the machine. */
export const SYS_COMMAND = "SYS 64738";
const SYS_COMPACT = SYS_COMMAND.replace(/\s+/g, "");
const MAX_BUFFER = 24;

/** Feeds keystrokes one at a time (KeyboardEvent.key values); `feed()` returns true when Enter
 * completes `SYS 64738` (spaces optional, any case, like a C64 that didn't care either). Any other
 * non-character key (arrows, Tab, Escape...) clears the buffer; Backspace deletes one character. */
export function createSysCommandMatcher() {
  let buffer = "";
  return {
    feed(key: string): boolean {
      if (key === "Enter") {
        const hit = buffer.replace(/\s+/g, "").toUpperCase().endsWith(SYS_COMPACT);
        buffer = "";
        return hit;
      }
      if (key === "Backspace") {
        buffer = buffer.slice(0, -1);
        return false;
      }
      if (key === "Shift" || key === "CapsLock") return false;
      if (key.length === 1) {
        buffer = (buffer + key).slice(-MAX_BUFFER);
        return false;
      }
      buffer = "";
      return false;
    },
    reset(): void {
      buffer = "";
    },
  };
}

export interface DoubleActivateOptions {
  /** A second activation within this many ms counts as a double-click/double-tap. */
  windowMs: number;
  onSingle: () => void;
  onDouble: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Single vs double activation for one icon, without breaking the single action: the first
 * pointer activation waits `windowMs` before running onSingle; a second one inside that window
 * cancels it and runs onDouble instead. Keyboard activation (Enter/Space) passes `immediate`, so
 * it runs onSingle straight away with no delay. Timers are injectable for tests. */
export function createDoubleActivate(opts: DoubleActivateOptions) {
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let pending: unknown = null;
  return {
    activate(immediate = false): void {
      if (immediate) {
        if (pending !== null) {
          clearTimer(pending);
          pending = null;
        }
        opts.onSingle();
        return;
      }
      if (pending !== null) {
        clearTimer(pending);
        pending = null;
        opts.onDouble();
        return;
      }
      pending = setTimer(() => {
        pending = null;
        opts.onSingle();
      }, opts.windowMs);
    },
    cancel(): void {
      if (pending !== null) clearTimer(pending);
      pending = null;
    },
  };
}
