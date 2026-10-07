import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useFocusTrap } from "../hooks/useFocusTrap.ts";

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
  useFocusTrap(ref, { onEscape: () => closeRef.current(), returnFocus, initial: "[role='menuitem']:not(:disabled)" });

  // Arrow keys walk the menu's actions.
  useEffect(() => {
    const sheet = ref.current;
    function onKey(event: KeyboardEvent) {
      if (!sheet || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
      const items = [...sheet.querySelectorAll<HTMLElement>(".sheet-menu [role='menuitem']:not(:disabled)")];
      const at = items.indexOf(document.activeElement as HTMLElement);
      if (at === -1) return;
      event.preventDefault();
      const next = event.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
      items[next]?.focus();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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
