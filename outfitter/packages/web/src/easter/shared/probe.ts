// Opt-in measurement hook for the art-review harness (see docs/reports/games.md, "Art pass 3").
// A no-op unless something has set `window.__easterProbe` to an array: then each renderer pushes
// the logical-pixel rects of what it drew this frame (helicopter, Floppies, racks, flame tops,
// signs, landmarks...), which the harness converts to screen px via the canvas's integer scale to
// check sizes and "fully in frame" rules on every sampled frame, not just the ones a human looked at.

export interface ProbeRect {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ProbeHost {
  __easterProbe?: ProbeRect[];
}

export function probeActive(): boolean {
  return Array.isArray((globalThis as ProbeHost).__easterProbe);
}

export function probe(name: string, x: number, y: number, w: number, h: number): void {
  const list = (globalThis as ProbeHost).__easterProbe;
  if (Array.isArray(list)) list.push({ name, x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
}

/** Called at the start of each rendered frame so the probe holds only the latest frame. */
export function probeReset(): void {
  const host = globalThis as ProbeHost;
  if (Array.isArray(host.__easterProbe)) host.__easterProbe.length = 0;
}
