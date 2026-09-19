/** Pure rendering for the MGM startup banner; tested without pi. */
export type Painter = (color: string, text: string) => string;

// 5x5 cell glyphs; each cell renders as two block characters so letters look square.
export const GLYPHS: Record<string, string[]> = {
  M: ["#...#", "##.##", "#.#.#", "#...#", "#...#"],
  G: [".####", "#....", "#..##", "#...#", ".####"],
};
export const WORD = "MGM";
const CELL = "██";
const GAP = "   ";
const SWEEP = ["accent", "accent", "borderAccent", "text", "muted"];   // top-to-bottom colour sweep

export function letters(paint: Painter, word = WORD): string[] {
  const rows: string[] = [];
  for (let r = 0; r < 5; r++) {
    const row = word.split("")
      .map((ch) => (GLYPHS[ch] ?? GLYPHS.M)[r].split("").map((c) => (c === "#" ? CELL : "  ")).join(""))
      .join(GAP);
    rows.push("  " + paint(SWEEP[r], row));
  }
  return rows;
}

export const NARROW_BELOW = 64;

export type BannerInput = { width: number; version: string; model?: { provider: string; id: string } };

/** Lines before width truncation; the caller truncates with pi-tui's truncateToWidth. */
export function bannerLines(paint: Painter, input: BannerInput): string[] {
  const { width, version, model: m } = input;
  const where = m ? `${m.provider}/${m.id}` : "no model — /connect";
  const narrow = width < NARROW_BELOW;
  const providers = ["lmstudio", "litellm", "openrouter"]
    .map((p) => (m?.provider === p ? paint("success", `● ${p}`) : paint("dim", `○ ${p}`)))
    .join(narrow ? " " : "   ");
  if (narrow) {
    return ["", "  " + paint("accent", "▌MGM▐") + " " + paint("dim", `pi v${version}`), "  " + providers, "  " + paint("text", "⇄ ") + paint("accent", where), ""];
  }
  const w = Math.max(20, Math.min(width - 4, 44));
  return [
    "",
    ...letters(paint),
    "",
    "  " + paint("muted", "the studio of one   ·   ") + paint("dim", `pi v${version}`),
    "  " + providers,
    "  " + paint("text", "⇄ ") + paint("accent", where),
    "  " + paint("dim", "─".repeat(w)) + " " + paint("dim", "/connect  /model  /help"),
    "",
  ];
}
