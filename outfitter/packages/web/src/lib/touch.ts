// Small, injectable touch-device check so the composer's placeholder never tells a phone to
// press a keyboard shortcut it doesn't have ("⌘/Ctrl+Enter to send" on an iPhone with no
// hardware keyboard reads as a bug, not a feature). `(hover: none) and (pointer: coarse)` is the
// standard "this is a touchscreen, not a mouse" media query; `maxTouchPoints` is a fallback for
// environments where matchMedia is unavailable (e.g. some test/SSR contexts).

export interface TouchEnv {
  matchMedia?: (query: string) => { matches: boolean };
  maxTouchPoints?: number;
}

export function isTouchDevice(env: TouchEnv): boolean {
  try {
    if (env.matchMedia && env.matchMedia("(hover: none) and (pointer: coarse)").matches) return true;
  } catch {
    // matchMedia unsupported or throws -- fall through to the maxTouchPoints check
  }
  return typeof env.maxTouchPoints === "number" && env.maxTouchPoints > 0;
}

/** Reads the real browser environment (window/navigator), for use outside tests. */
export function isTouchDeviceHere(): boolean {
  if (typeof window === "undefined") return false;
  return isTouchDevice({
    matchMedia: window.matchMedia?.bind(window),
    maxTouchPoints: window.navigator?.maxTouchPoints,
  });
}
