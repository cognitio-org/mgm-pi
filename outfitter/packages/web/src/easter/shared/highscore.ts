// Per-game high score persistence, localStorage, try/catch everywhere -- same convention as
// src/lib/floppy-sound.ts / ThemeToggle.tsx. Kept separate from either game's engine so the menu
// (src/easter/menu/GameMenu.tsx) can read both scores without importing either game's code.

export type GameId = "rescue" | "dreadnought";

const KEYS: Record<GameId, string> = {
  rescue: "outfitterEasterHighScore.rescue",
  // matches the key the original Dreadnought Run prototype used, so existing high scores survive
  // this refactor.
  dreadnought: "outfitterEasterHighScore",
};

export function readHighScore(game: GameId): number {
  try {
    const raw = localStorage.getItem(KEYS[game]);
    const n = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function writeHighScoreIfBetter(game: GameId, score: number): number {
  const current = readHighScore(game);
  if (score <= current) return current;
  try {
    localStorage.setItem(KEYS[game], String(Math.floor(score)));
  } catch {
    // best-effort only
  }
  return score;
}
