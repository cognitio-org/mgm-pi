import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

/**
 * A modal's keyboard (#498/#502: the phone sheet, the phone's Changes view, Create PR): focus goes
 * in when it opens (unless something inside already took it), Tab stays inside, Esc calls
 * `onEscape`, and focus goes back to whoever opened it -- `returnFocus`, or whatever had focus when
 * it opened. While a modal opened over it (or from inside it) is up, that one owns the keyboard.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  options: { onEscape?: () => void; returnFocus?: RefObject<HTMLElement | null>; initial?: string } = {},
): void {
  const escRef = useRef(options.onEscape);
  escRef.current = options.onEscape;
  const { returnFocus, initial } = options;

  useEffect(() => {
    const el = ref.current;
    const back = returnFocus?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    if (el && !el.contains(document.activeElement)) {
      (el.querySelector<HTMLElement>(initial ?? FOCUSABLE) ?? el.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    }
    function onKey(event: KeyboardEvent) {
      if (!el) return;
      // A modal after this one in the page (opened over it, or from inside it) owns the keyboard.
      const otherModal = [...document.querySelectorAll("[aria-modal='true']")].some(
        (m) => m !== el && (el.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      );
      if (otherModal) return;
      if (event.key === "Escape" && escRef.current) {
        event.preventDefault();
        event.stopPropagation();
        escRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !el.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !el.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (back?.isConnected) back.focus();
    };
  }, [ref, returnFocus, initial]);
}
