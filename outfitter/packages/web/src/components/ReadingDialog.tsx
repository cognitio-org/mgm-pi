import { useEffect, useRef } from "react";
import { readingTitle } from "../lib/reading.ts";
import { Markdown } from "./Markdown.tsx";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])';

// An HTML preview or image viewer opened from the prose is its own dialog. Escape and Tab
// belong to that one; this listener is registered first and would otherwise close both.
function keyBelongsToAnotherDialog(own: HTMLElement | null): boolean {
  const active = document.activeElement;
  if (active instanceof Element) {
    const modal = active.closest('[aria-modal="true"]');
    if (modal && modal !== own) return true;
  }
  for (const node of document.querySelectorAll('[role="dialog"]')) {
    if (node !== own) return true;
  }
  return false;
}

export function ReadingDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const title = readingTitle(text);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if ((e.key === "Escape" || e.key === "Tab") && keyBelongsToAnotherDialog(dialogRef.current)) return;
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      // Cycle ourselves: a native Tab leaves the dialog once the prose contains a link.
      e.preventDefault();
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const index = focusable.indexOf(document.activeElement as HTMLElement);
      if (e.shiftKey) (index <= 0 ? last : focusable[index - 1]!).focus();
      else (index < 0 || index >= focusable.length - 1 ? first : focusable[index + 1]!).focus();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      opener?.focus();
    };
  }, []);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="dialog panel html-preview-dialog reading-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="html-preview-toolbar">
          <span className="reading-title">{title}</span>
          <div className="html-preview-actions">
            <button type="button" className="btn mermaid-toolbar-btn" onClick={onClose} ref={closeRef}>
              Close
            </button>
          </div>
        </div>
        <div className="reading-body">
          <Markdown text={text} reading={false} />
        </div>
      </div>
    </div>
  );
}
