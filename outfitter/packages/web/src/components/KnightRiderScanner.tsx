import { useEffect, useRef } from "react";
import { drawScanner } from "../lib/scanner.ts";

/** How often the strip re-reads its colour (a theme or preference switch) and, when still, redraws. */
const COLOUR_REFRESH_MS = 1000;

/** #498: the Knight Rider scanner along the transcript/composer seam while a turn runs (see
 * lib/scanner.ts). Decorative: the live status line says the same thing in words. Its colour is
 * the canvas's CSS `color` -- `--scanner`, or `--ok` when the browser chose phosphor -- read about
 * once a second rather than every frame. Under reduced motion it's drawn still, with no frame loop. */
export function KnightRiderScanner() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduce = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    let colour = getComputedStyle(canvas).color;
    let colourAt = 0;
    let frame = 0;
    const paint = (t: number) => {
      if (t - colourAt >= COLOUR_REFRESH_MS) {
        colour = getComputedStyle(canvas).color;
        colourAt = t;
      }
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawScanner(ctx, w, h, t, colour, Boolean(reduce?.matches));
    };
    const loop = (t: number) => {
      paint(t);
      frame = requestAnimationFrame(loop);
    };
    let still: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      cancelAnimationFrame(frame);
      if (still) clearInterval(still);
      still = undefined;
      if (reduce?.matches) {
        // Still: one frame now, and again only if the colour or the width may have changed.
        paint(performance.now());
        still = setInterval(() => paint(performance.now()), COLOUR_REFRESH_MS);
      } else {
        frame = requestAnimationFrame(loop);
      }
    };
    start();
    reduce?.addEventListener?.("change", start);
    return () => {
      cancelAnimationFrame(frame);
      if (still) clearInterval(still);
      reduce?.removeEventListener?.("change", start);
    };
  }, []);

  return <canvas ref={ref} className="kitt-scanner" aria-hidden="true" />;
}
