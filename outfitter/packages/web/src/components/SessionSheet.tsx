import { useEffect, useRef, type ReactNode, type RefObject } from "react";

const FOCUSABLE = "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";

/**
 * #498: the phone's ⋯ bottom sheet: the floppy's menu, its details and the page's own controls.
 * A modal dialog: focus moves to its first action, Tab stays inside, arrow keys walk the menu, Esc
 * or the scrim closes it, and focus goes back to the ⋯ button. An Esc meant for a dialog opened
 * from inside it (the Drive's log viewer) is left to that dialog.
 */
export function SessionSheet({
  onClose,
  returnFocus,
  menu,
  children,
}: {
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  menu: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const sheet = ref.current;
    const back = returnFocus.current;
    sheet?.querySelector<HTMLElement>("[role='menuitem']:not(:disabled)")?.focus();
    function onKey(event: KeyboardEvent) {
      if (!sheet) return;
      // Another modal (opened from inside the sheet) owns the keyboard until it closes.
      const otherModal = [...document.querySelectorAll("[aria-modal='true']")].some((el) => el !== sheet);
      if (otherModal) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key === "Tab") {
        const items = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const active = document.activeElement;
        if (event.shiftKey && (active === first || !sheet.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !sheet.contains(active))) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const items = [...sheet.querySelectorAll<HTMLElement>(".sheet-menu [role='menuitem']:not(:disabled)")];
        const at = items.indexOf(document.activeElement as HTMLElement);
        if (at === -1) return;
        event.preventDefault();
        const next = event.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
        items[next]?.focus();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      back?.focus();
    };
  }, [returnFocus]);

  return (
    <>
      <div className="sheet-scrim" onClick={() => closeRef.current()} />
      <div ref={ref} className="session-sheet" role="dialog" aria-modal="true" aria-label="Floppy actions and details">
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-menu" role="menu" aria-label="Floppy actions">
          {menu}
        </div>
        {children}
      </div>
    </>
  );
}
