/** Pure rendering and identity logic for the mgm startup banner; tested without pi. */
export type Painter = (color: string, text: string) => string;

// 5x5 cell glyphs ('#' = block). Each cell renders as two block characters so letters look square.
export const GLYPHS: Record<string, string[]> = {
  A: [".###.", "#...#", "#####", "#...#", "#...#"],
  B: ["####.", "#...#", "####.", "#...#", "####."],
  C: [".####", "#....", "#....", "#....", ".####"],
  D: ["####.", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "###..", "#....", "#####"],
  F: ["#####", "#....", "###..", "#....", "#...."],
  G: [".####", "#....", "#..##", "#...#", ".####"],
  H: ["#...#", "#...#", "#####", "#...#", "#...#"],
  I: ["#####", "..#..", "..#..", "..#..", "#####"],
  J: ["#####", "...#.", "...#.", "#..#.", ".##.."],
  K: ["#...#", "#..#.", "###..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "####.", "#....", "#...."],
  Q: [".###.", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "####.", "#..#.", "#...#"],
  S: [".####", "#....", ".###.", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
  Y: ["#...#", ".#.#.", "..#..", "..#..", "..#.."],
  Z: ["#####", "...#.", "..#..", ".#...", "#####"],
  "0": [".###.", "#..##", "#.#.#", "##..#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "..##.", ".#...", "#####"],
  "4": ["#..#.", "#..#.", "#####", "...#.", "...#."],
};
const CELL = "██";
const GAP = "   ";

// ---------- identity ----------
export type Identity = {
  name: string;         // display name
  letters: string;      // block letters (≤ 4)
  tagline: string;
  sweep: string[];      // 5 theme colours, top row to bottom
  known: boolean;       // a recognised profile (gets the entrance animation)
};

/** Recognised users. Matching is by MGM_USER, git email/name, GitHub login or OS user, case-insensitive. */
export const PROFILES: { match: RegExp; identity: Identity }[] = [
  { match: /^(mgm|matthew|mgm@|mgmonteleone|matthewm@)/i, identity: { name: "Matthew", letters: "MGM", tagline: "the studio of one", sweep: ["accent", "accent", "borderAccent", "text", "muted"], known: true } },
  { match: /^(matej|tej|tej42000|matej@)/i, identity: { name: "Matej", letters: "MATEK", tagline: "welcome back, Matej  ·  TEJ42000", sweep: ["success", "success", "accent", "accent", "borderAccent"], known: true } },
];

export type IdentityHints = { MGM_USER?: string; gitEmail?: string; gitName?: string; githubLogin?: string; osUser?: string };

export function whoami(h: IdentityHints): Identity {
  const candidates = [h.MGM_USER, h.gitEmail, h.githubLogin, h.gitName, h.osUser].filter((s): s is string => !!s && s.trim().length > 0).map((s) => s.trim());
  for (const c of candidates) for (const p of PROFILES) if (p.match.test(c)) return p.identity;
  const given = (h.MGM_USER || h.gitName || h.osUser || "").trim();
  const name = given || "guest";
  const letters = (given ? given.replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase() : "") || "MGM";
  return { name, letters, tagline: `welcome, ${name}`, sweep: ["accent", "accent", "borderAccent", "text", "muted"], known: false };
}

// ---------- letters ----------
export function letters(paint: Painter, word: string, sweep: string[], revealCols?: number): string[] {
  const rows: string[] = [];
  const chars = word.toUpperCase().split("").map((ch) => GLYPHS[ch] ?? GLYPHS.M);
  const totalCols = chars.length * 5;
  const limit = revealCols ?? totalCols;
  for (let r = 0; r < 5; r++) {
    let col = 0;
    const row = chars
      .map((g) => g[r].split("").map((c) => { const on = c === "#" && col < limit; col++; return on ? CELL : "  "; }).join(""))
      .join(GAP);
    rows.push("  " + paint(sweep[r % sweep.length], row));
  }
  return rows;
}

export const NARROW_BELOW = 64;
export const REVEAL_STEPS = (word: string) => word.length * 5;   // one column per step
export const PULSE_FRAMES = 6;                                     // colour pulse after the reveal

export type BannerInput = { width: number; version: string; model?: { provider: string; id: string }; identity: Identity; frame?: number };

/**
 * Lines before width truncation; the caller truncates with pi-tui's truncateToWidth.
 * `frame` drives the entrance animation for recognised users: columns are revealed left to right,
 * then the sweep colours pulse once; beyond the last frame the banner is static.
 */
export function bannerLines(paint: Painter, input: BannerInput): string[] {
  const { width, version, model: m, identity } = input;
  const frame = input.frame ?? Infinity;
  const where = m ? `${m.provider}/${m.id}` : "no model — /connect";
  const narrow = width < NARROW_BELOW;
  const providers = ["lmstudio", "litellm", "openrouter"]
    .map((p) => (m?.provider === p ? paint("success", `● ${p}`) : paint("dim", `○ ${p}`)))
    .join(narrow ? " " : "   ");
  if (narrow) {
    return ["", "  " + paint("accent", `▌${identity.letters}▐`) + " " + paint("dim", `mgm on pi v${version}`), "  " + providers, "  " + paint("text", "⇄ ") + paint("accent", where), ""];
  }
  const reveal = REVEAL_STEPS(identity.letters);
  const cols = frame >= reveal ? undefined : frame;
  const pulse = frame >= reveal && frame < reveal + PULSE_FRAMES ? frame - reveal : -1;
  const sweep = pulse >= 0 ? identity.sweep.map((_, i) => identity.sweep[(i + pulse) % identity.sweep.length]) : identity.sweep;
  const w = Math.max(20, Math.min(width - 4, 44));
  return [
    "",
    ...letters(paint, identity.letters, sweep, cols),
    "",
    "  " + paint("muted", identity.tagline + "   ·   ") + paint("dim", `mgm on pi v${version}`),
    "  " + providers,
    "  " + paint("text", "⇄ ") + paint("accent", where),
    "  " + paint("dim", "─".repeat(w)) + " " + paint("dim", "/connect  /setup  /model  /help"),
    "",
  ];
}

/** Total animation frames for an identity (reveal + pulse); 0 for unknown users (no animation). */
export const animationFrames = (identity: Identity) => (identity.known ? REVEAL_STEPS(identity.letters) + PULSE_FRAMES : 0);
