import { useEffect, useRef } from "react";
import { drawScanner } from "../lib/scanner.ts";

/** #498: the Knight Rider scanner along the transcript/composer seam while a turn runs (see
 * lib/scanner.ts). Decorative: the live status line says the same thing in words. Its colour is
 * the canvas's CSS `color` -- `--scanner`, or `--ok` when the browser chose phosphor -- read each
 * frame so a theme or preference switch shows at once. */
export function KnightRiderScanner() {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduce = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    let frame = 0;
    const paint = (t: number) => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawScanner(ctx, w, h, t, getComputedStyle(canvas).color, Boolean(reduce?.matches));
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, []);

  return <canvas ref={ref} className="kitt-scanner" aria-hidden="true" />;
}
