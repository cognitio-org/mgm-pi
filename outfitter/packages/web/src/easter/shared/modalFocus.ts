// Focus containment for the easter-egg overlay. openEasterEgg() mounts each dialog into a
// standalone DOM node appended to <body> (see openEasterEgg.tsx), outside the React app tree, so
// nothing else marks the app behind it inert or hides it from assistive tech: without this, Tab
// happily walks out of the dialog and into the composer/nav/session page underneath while the
// game's own window-level key listeners are still armed, so a stray "s"/"w"/arrow key both flies
// the ship *and* lands in whatever background field now has focus. useModalFocus keeps Tab (and
// Shift+Tab) cycling inside the dialog and restores focus to whatever had it before the dialog
// opened (the Trash icon, the menu button, ...) once it closes.
import { useEffect } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true",
  );
}

/** Traps Tab/Shift+Tab focus inside `containerRef`'s subtree, moves focus onto the first
 * focusable element in it on mount (or the container itself if it has none), and restores focus
 * to whatever was focused immediately before mount once this hook tears down (dialog closed, or
 * `active` goes false). Re-runs its setup whenever `active` flips true, so it also works for a
 * component that's always mounted but toggles visibility. */
export function useModalFocus(containerRef: React.RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    // Bind to a definitely-non-null local with an explicit type annotation: TS's control-flow
    // narrowing of `containerRef.current` doesn't carry into the nested onKeyDown closure below
    // (a known limitation for nested function declarations), so a plain `const containerEl =
    // containerRef.current` after the guard still types as `HTMLElement | null` in there.
    const maybeContainer = containerRef.current;
    if (!maybeContainer) return;
    const containerEl: HTMLElement = maybeContainer;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (!containerEl.contains(document.activeElement)) {
      const first = focusableIn(containerEl)[0];
      if (first) first.focus();
      else containerEl.focus();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Tab") return;
      const focusable = focusableIn(containerEl);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const activeEl = document.activeElement;
      if (e.shiftKey) {
        if (activeEl === first || !containerEl.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || !containerEl.contains(activeEl)) {
        e.preventDefault();
        first.focus();
      }
    }

    containerEl.addEventListener("keydown", onKeyDown);
    return () => {
      containerEl.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    };
  }, [containerRef, active]);
}

/** Just the "restore focus to whatever had it before" half of useModalFocus, for a dialog (like
 * GameMenu) that already manages its own Tab order and initial focus but still needs to hand
 * focus back to the Trash icon / menu button that opened it once it unmounts. */
export function useRestoreFocus(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    };
  }, [active]);
}
