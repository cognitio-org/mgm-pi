import { useEffect, useRef, useState } from "react";

// Full-screen view of an already-rendered, already-sanitized diagram SVG (MermaidDiagram passes
// the same string it validated with lib/mermaid-safety.ts and already inserted once -- this
// dialog doesn't re-fetch or re-render anything, just gives it more room plus pan/zoom).
//
// Pan/zoom is Pointer Events throughout (unifies mouse drag and touch drag/pinch, so the same
// code handles a desktop trackpad-and-mouse and an iPhone's touchscreen): a single active pointer
// pans, two active pointers pinch-zoom around their midpoint, and a wheel event zooms around the
// cursor (mouse wheel, or a trackpad's synthetic wheel+ctrlKey pinch gesture).
//
// Fit measures that same SVG against the surface (getBoundingClientRect is in post-transform
// pixels, so the current scale/translation is divided back out) and centers it with a little
// padding. Reset stays the identity view. Download writes the sanitized string unchanged.

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;

/** Surface-space margin Fit leaves around the diagram, in CSS pixels. */
export const FIT_PADDING = 24;

const DIAGRAM_FILENAME = "diagram.svg";

export interface Transform {
  scale: number;
  x: number;
  y: number;
}

export interface FitSize {
  width: number;
  height: number;
}

/** Unscaled diagram box. `x`/`y` are its top-left in transform-local space (canvas origin). */
export interface FitContent extends FitSize {
  x?: number;
  y?: number;
}

export interface FitRect extends FitSize {
  left: number;
  top: number;
}

const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * Scale and translation that fits `content` inside `surface`, centered, with FIT_PADDING of
 * margin on the tight axis. Scale may drop below the wheel-zoom floor so a large diagram is
 * still fully visible; it will not grow past the zoom ceiling. A zero-sized box stays at identity.
 */
export function fitTransform(surface: FitSize, content: FitContent): Transform {
  const offsetX = content.x ?? 0;
  const offsetY = content.y ?? 0;
  if (!(surface.width > 0) || !(surface.height > 0) || !(content.width > 0) || !(content.height > 0)) {
    return { ...IDENTITY };
  }
  if (!Number.isFinite(offsetX) || !Number.isFinite(offsetY)) return { ...IDENTITY };
  const pad = surface.width > FIT_PADDING * 2 && surface.height > FIT_PADDING * 2 ? FIT_PADDING : 0;
  const availW = surface.width - pad * 2;
  const availH = surface.height - pad * 2;
  const scale = Math.min(MAX_SCALE, availW / content.width, availH / content.height);
  if (!Number.isFinite(scale) || scale <= 0) return { ...IDENTITY };
  return {
    scale,
    x: (surface.width - content.width * scale) / 2 - offsetX * scale,
    y: (surface.height - content.height * scale) / 2 - offsetY * scale,
  };
}

/**
 * Unscaled size and origin of the svg, recovered from live rects. getBoundingClientRect includes
 * the canvas transform, so the same diagram measured after a pan yields the same content box
 * (and therefore the same fitTransform result).
 */
export function diagramContent(surface: FitRect, svg: FitRect, transform: Transform): FitContent {
  const scale = transform.scale;
  if (!(scale > 0) || !(svg.width > 0) || !(svg.height > 0)) return { width: 0, height: 0 };
  const x = (svg.left - surface.left - transform.x) / scale;
  const y = (svg.top - surface.top - transform.y) / scale;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { width: 0, height: 0 };
  return { width: svg.width / scale, height: svg.height / scale, x, y };
}

/** The sanitized SVG string, unchanged, as a downloadable image/svg+xml blob. */
export function mermaidSvgBlob(svg: string): Blob {
  return new Blob([svg], { type: "image/svg+xml" });
}

function downloadDiagram(svg: string) {
  const blob = mermaidSvgBlob(svg);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = DIAGRAM_FILENAME;
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    URL.revokeObjectURL(url);
  }
}

export function MermaidEnlargeDialog({ svg, onClose }: { svg: string; onClose: () => void }) {
  const [transform, setTransform] = useState<Transform>({ ...IDENTITY });
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const pinchStart = useRef<{ distance: number; scale: number } | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Latest onClose without re-running the focus effect below (the parent passes a fresh arrow
  // every render, which would otherwise bounce focus to the opener and back on each re-render).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    // Modal: focus the close button, keep Tab inside the dialog, and hand focus back to whatever
    // opened it (the Enlarge button) on close.
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
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
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

  // Wheel zoom needs a non-passive listener: React registers onWheel as passive, so
  // preventDefault() there is ignored -- the page behind scrolls, and a trackpad pinch
  // (ctrl+wheel) zooms the whole browser page instead of the diagram.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * 0.0015);
      setTransform((t) => ({ ...t, scale: clampScale(t.scale * factor) }));
    }
    surface.addEventListener("wheel", onWheel, { passive: false });
    return () => surface.removeEventListener("wheel", onWheel);
  }, []);

  function pointerDistance(): number {
    const pts = [...pointers.current.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      dragStart.current = { x: e.clientX, y: e.clientY, tx: transform.x, ty: transform.y };
    } else if (pointers.current.size === 2) {
      dragStart.current = null;
      pinchStart.current = { distance: pointerDistance() || 1, scale: transform.scale };
    }
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size >= 2 && pinchStart.current) {
      const distance = pointerDistance() || 1;
      const nextScale = clampScale(pinchStart.current.scale * (distance / pinchStart.current.distance));
      setTransform((t) => ({ ...t, scale: nextScale }));
      return;
    }
    if (pointers.current.size === 1 && dragStart.current) {
      const dx = e.clientX - dragStart.current.x;
      const dy = e.clientY - dragStart.current.y;
      setTransform((t) => ({ ...t, x: dragStart.current!.tx + dx, y: dragStart.current!.ty + dy }));
    }
  }

  function endPointer(e: React.PointerEvent<HTMLDivElement>) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchStart.current = null;
    if (pointers.current.size === 1) {
      const [[, p]] = pointers.current;
      dragStart.current = { x: p.x, y: p.y, tx: transform.x, ty: transform.y };
    } else if (pointers.current.size === 0) {
      dragStart.current = null;
    }
  }

  function resetView() {
    setTransform({ ...IDENTITY });
  }

  function fitView() {
    const surface = surfaceRef.current;
    const svgEl = surface?.querySelector("svg");
    if (!surface || !svgEl) return;
    const surfaceRect = surface.getBoundingClientRect();
    const svgRect = svgEl.getBoundingClientRect();
    setTransform((current) =>
      fitTransform({ width: surfaceRect.width, height: surfaceRect.height }, diagramContent(surfaceRect, svgRect, current)),
    );
  }

  return (
    <div className="dialog-backdrop mermaid-enlarge-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="dialog panel mermaid-enlarge-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Diagram, enlarged"
      >
        <div className="mermaid-enlarge-toolbar">
          <button type="button" className="btn mermaid-toolbar-btn" onClick={fitView}>
            Fit
          </button>
          <button type="button" className="btn mermaid-toolbar-btn" onClick={resetView}>
            Reset
          </button>
          <button type="button" className="btn mermaid-toolbar-btn" onClick={() => downloadDiagram(svg)}>
            Download
          </button>
          <button type="button" className="btn mermaid-toolbar-btn" onClick={onClose} ref={closeRef} aria-label="Close">
            ✕ Close
          </button>
        </div>
        <div
          ref={surfaceRef}
          className="mermaid-enlarge-surface"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onPointerLeave={endPointer}
        >
          <div
            className="mermaid-enlarge-canvas"
            style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})` }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      </div>
    </div>
  );
}
