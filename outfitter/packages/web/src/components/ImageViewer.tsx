import { useEffect, useRef, useState } from "react";

// Pan/zoom matches MermaidEnlargeDialog: one pointer pans, two pinch, wheel zooms. The wheel
// listener is non-passive so preventDefault actually stops the page behind from scrolling.
// A data: href is often navigated instead of saved, so Download decodes those bytes into a blob
// URL first. A blob: URL (a browser-capture object URL) is already those bytes and is saved as-is.

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;

export interface ViewTransform {
  scale: number;
  x: number;
  y: number;
}

export function clampImageScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function wheelZoom(scale: number, deltaY: number): number {
  return clampImageScale(scale * Math.exp(-deltaY * 0.0015));
}

export function panBy(
  origin: { x: number; y: number },
  start: { x: number; y: number },
  point: { x: number; y: number },
): { x: number; y: number } {
  return { x: origin.x + (point.x - start.x), y: origin.y + (point.y - start.y) };
}

export function pointerDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pinchZoom(startScale: number, startDistance: number, distance: number): number {
  const base = startDistance || 1;
  return clampImageScale(startScale * ((distance || 1) / base));
}

export function imageTransformStyle(transform: ViewTransform): string {
  return `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
}

export function imageDownloadFilename(filename?: string): string {
  const name = filename?.trim();
  return name ? name : "image";
}

/** Decode a data URL into a Blob. Returns null for anything that is not a data URL. */
export function dataUrlToBlob(src: string): Blob | null {
  if (!/^data:/i.test(src)) return null;
  const comma = src.indexOf(",");
  if (comma < 5) return null;
  const meta = src.slice(5, comma);
  const payload = src.slice(comma + 1);
  const parts = meta.split(";").filter((part) => part.length > 0);
  const isBase64 = parts.some((part) => part.toLowerCase() === "base64");
  const typePart = parts.find((part) => part.toLowerCase() !== "base64" && !part.toLowerCase().startsWith("charset="));
  const type = typePart && typePart.includes("/") ? typePart : "application/octet-stream";
  try {
    if (isBase64) {
      const binary = atob(payload.replace(/\s/g, ""));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
      return new Blob([bytes], { type });
    }
    return new Blob([decodeURIComponent(payload)], { type });
  } catch {
    return null;
  }
}

function triggerDownload(href: string, filename: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  triggerDownload(url, filename);
  // Revoking in the same turn can cancel the save; the click only starts it.
  setTimeout(() => URL.revokeObjectURL?.(url), 1000);
}

export function ImageViewer({
  src,
  filename,
  alt,
  onClose,
}: {
  src: string;
  filename?: string;
  alt?: string;
  onClose: () => void;
}) {
  const [transform, setTransform] = useState<ViewTransform>({ scale: 1, x: 0, y: 0 });
  // A second pointer event can arrive before React re-renders.
  const transformRef = useRef(transform);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const pinchStart = useRef<{ distance: number; scale: number } | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  function commit(next: ViewTransform) {
    transformRef.current = next;
    setTransform(next);
  }

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>("button:not([disabled])"));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      opener?.focus();
    };
  }, []);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    function liveDistance(): number {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return 0;
      return pointerDistance(pts[0]!, pts[1]!);
    }

    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const current = transformRef.current;
      commit({ ...current, scale: wheelZoom(current.scale, e.deltaY) });
    }

    function onPointerDown(e: PointerEvent) {
      surface!.setPointerCapture?.(e.pointerId);
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size === 1) {
        const current = transformRef.current;
        dragStart.current = { x: e.clientX, y: e.clientY, tx: current.x, ty: current.y };
      } else if (pointers.current.size === 2) {
        dragStart.current = null;
        pinchStart.current = { distance: liveDistance() || 1, scale: transformRef.current.scale };
      }
    }

    function onPointerMove(e: PointerEvent) {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.current.size >= 2 && pinchStart.current) {
        const nextScale = pinchZoom(pinchStart.current.scale, pinchStart.current.distance, liveDistance());
        commit({ ...transformRef.current, scale: nextScale });
        return;
      }
      if (pointers.current.size === 1 && dragStart.current) {
        const next = panBy(
          { x: dragStart.current.tx, y: dragStart.current.ty },
          { x: dragStart.current.x, y: dragStart.current.y },
          { x: e.clientX, y: e.clientY },
        );
        commit({ ...transformRef.current, x: next.x, y: next.y });
      }
    }

    function endPointer(e: PointerEvent) {
      pointers.current.delete(e.pointerId);
      if (pointers.current.size < 2) pinchStart.current = null;
      if (pointers.current.size === 1) {
        const [[, p]] = [...pointers.current];
        const current = transformRef.current;
        dragStart.current = p ? { x: p.x, y: p.y, tx: current.x, ty: current.y } : null;
      } else if (pointers.current.size === 0) {
        dragStart.current = null;
      }
    }

    surface.addEventListener("wheel", onWheel, { passive: false });
    surface.addEventListener("pointerdown", onPointerDown);
    surface.addEventListener("pointermove", onPointerMove);
    surface.addEventListener("pointerup", endPointer);
    surface.addEventListener("pointercancel", endPointer);
    surface.addEventListener("pointerleave", endPointer);
    return () => {
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("pointerdown", onPointerDown);
      surface.removeEventListener("pointermove", onPointerMove);
      surface.removeEventListener("pointerup", endPointer);
      surface.removeEventListener("pointercancel", endPointer);
      surface.removeEventListener("pointerleave", endPointer);
    };
  }, []);

  function onDownload() {
    const name = imageDownloadFilename(filename);
    if (/^blob:/i.test(src)) {
      triggerDownload(src, name);
      return;
    }
    const blob = dataUrlToBlob(src);
    if (blob) saveBlob(blob, name);
    else triggerDownload(src, name);
  }

  const label = alt?.trim() || "Image";

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="dialog panel image-viewer-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        <div className="image-viewer-toolbar">
          <button type="button" className="btn mermaid-toolbar-btn" onClick={() => commit({ scale: 1, x: 0, y: 0 })}>
            Reset
          </button>
          <button type="button" className="btn mermaid-toolbar-btn" onClick={onDownload}>
            Download
          </button>
          <button type="button" className="btn mermaid-toolbar-btn" onClick={onClose} ref={closeRef}>
            Close
          </button>
        </div>
        <div ref={surfaceRef} className="image-viewer-surface">
          <div className="image-viewer-canvas" style={{ transform: imageTransformStyle(transform) }}>
            <img src={src} alt={alt ?? ""} draggable={false} />
          </div>
        </div>
      </div>
    </div>
  );
}
