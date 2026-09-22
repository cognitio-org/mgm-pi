// URL switches both games read, for headless screenshots/recordings: ?demo=1 (autopilot keeps
// flying past the title), ?touch=1 (force the touch controls on), ?seed=N (a fixed RNG seed, so a
// recorded demo run is reproducible instead of depending on Date.now()).

export function readQueryFlag(name: string): boolean {
  try {
    return new URLSearchParams(window.location.search).get(name) === "1";
  } catch {
    return false;
  }
}

/** The ?seed=N value if present, otherwise a fresh time-based seed. */
export function gameSeed(): number {
  try {
    const raw = new URLSearchParams(window.location.search).get("seed");
    if (raw !== null && /^\d+$/.test(raw)) return Number(raw) >>> 0;
  } catch {
    // fall through
  }
  return Date.now() & 0xffffffff;
}
