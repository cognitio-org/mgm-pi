// Maps our theme tokens (styles/theme.css custom properties) onto mermaid's `theme: "base"`
// themeVariables, so a diagram looks native in both the C64 dark theme and the GEOS light theme
// instead of mermaid's own default palette. Kept as a pure function (tokens in, mermaid
// themeVariables out) so it's testable without touching the DOM or importing mermaid itself --
// see test/mermaid-theme.test.ts.

/** The subset of theme.css custom properties this mapping reads. */
export interface ThemeTokens {
  bg: string;
  bgElevated: string;
  bgInset: string;
  border: string;
  borderStrong: string;
  text: string;
  textDim: string;
  accent: string;
  accentContrast: string;
  ok: string;
  warn: string;
  danger: string;
  fontBody: string;
  fontMono: string;
}

/** mermaid's `theme: "base"` themeVariables shape is large; we only set the handful that matter
 * for a legible, on-brand flowchart/sequence diagram and leave the rest at mermaid's defaults. */
export function buildMermaidThemeVariables(tokens: ThemeTokens): Record<string, string> {
  return {
    background: tokens.bgElevated,
    fontFamily: tokens.fontMono,
    primaryColor: tokens.bgInset,
    primaryTextColor: tokens.text,
    primaryBorderColor: tokens.border,
    secondaryColor: tokens.bgElevated,
    secondaryTextColor: tokens.text,
    secondaryBorderColor: tokens.border,
    tertiaryColor: tokens.bgElevated,
    tertiaryTextColor: tokens.text,
    tertiaryBorderColor: tokens.borderStrong,
    lineColor: tokens.border,
    textColor: tokens.text,
    mainBkg: tokens.bgInset,
    nodeBorder: tokens.border,
    clusterBkg: tokens.bg,
    clusterBorder: tokens.border,
    edgeLabelBackground: tokens.bgElevated,
    titleColor: tokens.text,
    actorBkg: tokens.bgInset,
    actorBorder: tokens.border,
    actorTextColor: tokens.text,
    actorLineColor: tokens.border,
    signalColor: tokens.text,
    signalTextColor: tokens.text,
    labelBoxBkgColor: tokens.bgInset,
    labelBoxBorderColor: tokens.border,
    labelTextColor: tokens.text,
    loopTextColor: tokens.text,
    noteBkgColor: tokens.warn,
    noteTextColor: tokens.bg,
    noteBorderColor: tokens.border,
    errorBkgColor: tokens.danger,
    errorTextColor: tokens.bg,
    activationBkgColor: tokens.bgInset,
    activationBorderColor: tokens.border,
    sequenceNumberColor: tokens.accentContrast,
  } satisfies Record<string, string>;
}

/** Fallback used when the live document doesn't have theme.css's custom properties resolved yet
 * (a render before first paint, or a test environment with no stylesheet loaded). Matches
 * theme.css's dark (C64 phosphor) default so a diagram still renders on-brand rather than with
 * mermaid's own default palette. */
export const DEFAULT_THEME_TOKENS: ThemeTokens = {
  bg: "#302870",
  bgElevated: "#3a3184",
  bgInset: "#251f5c",
  border: "#8b7cd8",
  borderStrong: "#b3a8f0",
  text: "#e4e0fb",
  textDim: "#a89fe0",
  accent: "#7869c4",
  accentContrast: "#12103a",
  ok: "#5cff8a",
  warn: "#f4cf3c",
  danger: "#ff8a8a",
  fontBody: "IBM Plex Sans, sans-serif",
  fontMono: "IBM Plex Mono, monospace",
};

/** Reads the tokens this mapping needs off the live document (custom properties resolved on
 * `<html>`, which theme.css sets via `:root`/`[data-theme]`). Returns null outside a browser
 * (SSR/tests) so callers can fall back to a default rather than crash. */
export function readThemeTokensFromDocument(): ThemeTokens | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  const style = window.getComputedStyle(document.documentElement);
  const read = (name: string) => style.getPropertyValue(name).trim();
  const bg = read("--bg");
  if (!bg) return null;
  return {
    bg,
    bgElevated: read("--bg-elevated"),
    bgInset: read("--bg-inset"),
    border: read("--border"),
    borderStrong: read("--border-strong"),
    text: read("--text"),
    textDim: read("--text-dim"),
    accent: read("--accent"),
    accentContrast: read("--accent-contrast"),
    ok: read("--ok"),
    warn: read("--warn"),
    danger: read("--danger"),
    fontBody: read("--font-body") || "sans-serif",
    fontMono: read("--font-mono") || "monospace",
  };
}
