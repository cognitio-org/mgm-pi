import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/** A button that opens a small menu under it (#498: the floppy's ⋯ menu, the Disk Box's page
 * links). Closes on a click outside, on Esc (focus back on the button), and after an item runs.
 * Items are plain buttons or links with role="menuitem"; arrow keys move between them. Tab, or
 * focus leaving the menu, closes it. */
export function PopMenu({
  label,
  icon,
  className,
  align = "end",
  placement = "below",
  children,
}: {
  /** The button's accessible name and tooltip. */
  label: string;
  icon: ReactNode;
  className?: string;
  align?: "start" | "end";
  placement?: "below" | "above";
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const wrap = wrapRef.current;
    wrap?.querySelector<HTMLElement>("[role='menu'] [role^='menuitem']:not(:disabled)")?.focus();
    function onPointer(event: PointerEvent) {
      if (event.target instanceof Node && wrap?.contains(event.target)) return;
      setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      // Only while focus is in this menu (or on its button): keys elsewhere are someone else's.
      if (!(document.activeElement instanceof Node && wrap?.contains(document.activeElement))) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      if (event.key === "Tab") {
        // Tab leaves the menu, as it would a native one.
        setOpen(false);
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const items = [...(wrap?.querySelectorAll<HTMLElement>("[role='menu'] [role^='menuitem']:not(:disabled)") ?? [])];
      if (items.length === 0) return;
      event.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
      items[next]?.focus();
    }
    // Focus moving out of the menu (a click elsewhere, a screen reader jump) closes it.
    function onFocusOut(event: FocusEvent) {
      const next = event.relatedTarget;
      if (next instanceof Node && wrap?.contains(next)) return;
      if (next === null) return; // focus went nowhere (a click on empty space): the pointer handler decides
      setOpen(false);
    }
    wrap?.addEventListener("focusout", onFocusOut);
    document.addEventListener("pointerdown", onPointer);
    // Capture, so Esc closes the menu before the page's own Esc (Break) sees it.
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
      wrap?.removeEventListener("focusout", onFocusOut);
    };
  }, [open]);

  return (
    <span className={`pop-menu${className ? ` ${className}` : ""}`} ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="icon-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {icon}
      </button>
      {open ? (
        <div id={menuId} className={`pop-menu-list is-${align} is-${placement}`} role="menu" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </span>
  );
}
