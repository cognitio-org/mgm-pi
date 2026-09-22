// prefers-reduced-motion detection, shared by both games so the "calmer mode" notice/behaviour is
// consistent: no screen shake, fewer particles, no continuous background scroll dressing, steady
// (not blinking) invulnerability highlight.

export function usesReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
