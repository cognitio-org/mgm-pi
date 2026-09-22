// Integer pixel scaling for the game canvases. Both engines simulate a 240x132 logical world; this
// picks the largest *integer* scale factor that fits the viewport (so every logical pixel becomes an
// exact N x N block of screen pixels -- no uneven 3.56x blur), and on narrow screens shows a
// narrower slice of the world (`viewW`, down to MIN_VIEW_W) at a bigger scale instead of shrinking
// the whole 240px world to fit. At 1280x860 that's scale 5 / viewW 240 (a 1200x660 canvas); at
// 390x844 it's scale 2 / viewW 195 (a 390x264 canvas, the full screen width).

import { useEffect, useState } from "react";

export const MIN_VIEW_W = 180;

export interface PixelScale {
  /** CSS px per logical px (integer >= 1). */
  scale: number;
  /** Logical width of the visible slice of the world. */
  viewW: number;
}

/** Height reserved for the frame's chrome (titlebar, help line, borders, overlay padding) on
 * desktop; narrow/touch layouts are width-bound, so it doesn't matter there. */
const CHROME_RESERVE_PX = 128;

export function computePixelScale(winW: number, winH: number, worldW: number, worldH: number): PixelScale {
  // Desktop: 1rem overlay padding + a 3px frame border each side. Phones (<= 480px, see
  // easter.css): the game window is full-bleed, no padding or side borders.
  const narrow = winW <= 480;
  const availW = narrow ? winW : winW - 16 * 2 - 6;
  const availH = winH - CHROME_RESERVE_PX;
  const minView = Math.min(MIN_VIEW_W, worldW);
  const scale = Math.max(1, Math.floor(Math.min(availW / minView, availH / worldH)));
  const viewW = Math.max(minView, Math.min(worldW, Math.floor(availW / scale)));
  return { scale, viewW };
}

export function usePixelScale(worldW: number, worldH: number): PixelScale {
  const [ps, setPs] = useState<PixelScale>(() =>
    typeof window === "undefined"
      ? { scale: 3, viewW: worldW }
      : computePixelScale(window.innerWidth, window.innerHeight, worldW, worldH),
  );
  useEffect(() => {
    function onResize() {
      const next = computePixelScale(window.innerWidth, window.innerHeight, worldW, worldH);
      setPs((prev) => (prev.scale === next.scale && prev.viewW === next.viewW ? prev : next));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [worldW, worldH]);
  return ps;
}
