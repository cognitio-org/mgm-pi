// Fixed-timestep game loop, shared by both games so physics stays deterministic (same behaviour at
// 60Hz, 120Hz or a throttled background tab) instead of tying simulation speed to display refresh
// rate. Standard accumulator pattern: rAF drives wall-clock time, but the callback is invoked in
// fixed FIXED_DT_MS chunks, with a cap on catch-up steps per frame so a long stall (tab switch,
// devtools pause) can't spiral into a "spiral of death" of ever-larger catch-up work.
//
// Also owns the "pause the loop while the tab is hidden" rule required by the brief: the rAF loop
// itself is torn down on `visibilitychange` -> hidden and restarted on -> visible, rather than
// just skipping ticks, so a backgrounded game doesn't burn CPU at all.

import { useEffect, useRef } from "react";

export const FIXED_DT_MS = 1000 / 60;
const MAX_STEPS_PER_FRAME = 5;

/** Calls `onStep(FIXED_DT_MS)` zero or more times per animation frame to keep simulation time in
 * sync with wall-clock time, then calls `onRender()` once per frame after stepping. Runs only
 * while `active` is true and the document is visible. */
export function useFixedStepLoop(onStep: (dtMs: number) => void, onRender: () => void, active: boolean): void {
  const onStepRef = useRef(onStep);
  const onRenderRef = useRef(onRender);
  onStepRef.current = onStep;
  onRenderRef.current = onRender;

  useEffect(() => {
    if (!active) return;
    let rafId: number | null = null;
    let last: number | null = null;
    let accumulator = 0;

    function frame(ts: number) {
      if (last === null) last = ts;
      const elapsed = Math.min(ts - last, 250); // clamp a long stall to avoid a catch-up spiral
      last = ts;
      accumulator += elapsed;
      let steps = 0;
      while (accumulator >= FIXED_DT_MS && steps < MAX_STEPS_PER_FRAME) {
        onStepRef.current(FIXED_DT_MS);
        accumulator -= FIXED_DT_MS;
        steps += 1;
      }
      onRenderRef.current();
      rafId = requestAnimationFrame(frame);
    }

    function start() {
      if (rafId !== null || document.hidden) return;
      last = null;
      rafId = requestAnimationFrame(frame);
    }

    function stop() {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    }

    function onVisibilityChange() {
      if (document.hidden) stop();
      else start();
    }

    start();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [active]);
}
