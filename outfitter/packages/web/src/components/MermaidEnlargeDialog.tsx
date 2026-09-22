import { useEffect, useRef, useState } from "react";

// Full-screen view of an already-rendered, already-sanitized diagram SVG (MermaidDiagram passes
// the same string it validated with lib/mermaid-safety.ts and already inserted once -- this
// dialog doesn't re-fetch or re-render anything, just gives it more room plus pan/zoom).
//
// Pan/zoom is Pointer Events throughout (unifies mouse drag and touch drag/pinch, so the same
// code handles a desktop trackpad-and-mouse and an iPhone's touchscreen): a single active pointer
// pans, two active pointers pinch-zoom around their midpoint, and a wheel event zooms around the
// cursor (mouse wheel, or a trackpad's synthetic wheel+ctrlKey pinch gesture).

const MIN_SCALE = 0.25;
const MAX_SCALE = 8;

interface Transform {
  scale: number;
  x: number;
  y: number;
}

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function MermaidEnlargeDialog({ svg, onClose }: { svg: string; onClose: () => void }) {
  const [transform, setTransform] = useState<Transform>({ scale: 1, x: 0, y: 0 });
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const pinchStart = useRef<{ distance: number; scale: number } | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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

  function onWheel(e: React.WheelEvent<HTMLDivElement>) {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0015);
    setTransform((t) => ({ ...t, scale: clampScale(t.scale * factor) }));
  }

  function resetView() {
    setTransform({ scale: 1, x: 0, y: 0 });
  }

  return (
    <div className="dialog-backdrop mermaid-enlarge-backdrop" onClick={onClose}>
      <div
        className="dialog panel mermaid-enlarge-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Diagram, enlarged"
      >
        <div className="mermaid-enlarge-toolbar">
          <button type="button" className="btn mermaid-toolbar-btn" onClick={resetView}>
            Reset
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
          onWheel={onWheel}
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
