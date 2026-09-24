import { useEffect, useRef, useState } from "react";
import { previewSandbox, previewSrcDoc, type PreviewAccess } from "../lib/html-preview.ts";

// Renders one HTML fence in a dialog. External CSS and JS are blocked until the person
// checks the box in this dialog. Either way the frame is a unique origin: it cannot read
// this page. The transcript itself keeps showing the source as code.

export function HtmlPreviewDialog({ source, onClose }: { source: string; onClose: () => void }) {
  const [access, setAccess] = useState<PreviewAccess>("sealed");
  const [expanded, setExpanded] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" && e.key !== "Tab") return;
      const own = dialogRef.current;
      const modals = document.querySelectorAll('[aria-modal="true"]');
      // A later modal (the image viewer, portaled onto document.body) is on top.
      if (own && modals.length > 0 && modals[modals.length - 1] !== own) return;
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onCloseRef.current();
        return;
      }
      if (!own) return;
      e.stopImmediatePropagation();
      const focusable = Array.from(
        own.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])"),
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !own.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !own.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
    // Capture so this dialog, not the reading dialog under it, handles Escape and Tab.
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      opener?.focus();
    };
  }, []);

  return (
    <div className={expanded ? "dialog-backdrop html-preview-backdrop-expanded" : "dialog-backdrop"} onClick={onClose}>
      <div
        ref={dialogRef}
        className={expanded ? "dialog panel html-preview-dialog is-expanded" : "dialog panel html-preview-dialog"}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Rendered HTML"
      >
        <div className="html-preview-toolbar">
          <span className="html-preview-note">
            {access === "external"
              ? "This preview can load external CSS and JS. It still cannot reach this page."
              : "External CSS and JS are blocked. This preview cannot reach this page."}
          </span>
          <div className="html-preview-actions">
            <label className="html-preview-allow">
              <input
                type="checkbox"
                checked={access === "external"}
                onChange={(e) => setAccess(e.target.checked ? "external" : "sealed")}
              />
              Allow external CSS and JS
            </label>
            <button
              type="button"
              className="btn mermaid-toolbar-btn"
              aria-pressed={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Shrink" : "Expand"}
            </button>
            <button type="button" className="btn mermaid-toolbar-btn" onClick={onClose} ref={closeRef}>
              Close
            </button>
          </div>
        </div>
        <iframe
          key={access}
          className="html-preview-frame"
          title="Rendered HTML"
          sandbox={previewSandbox(access)}
          referrerPolicy="no-referrer"
          srcDoc={previewSrcDoc(source, access)}
        />
      </div>
    </div>
  );
}
