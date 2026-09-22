import { describe, it, expect } from "vitest";
import { buildMermaidThemeVariables, DEFAULT_THEME_TOKENS } from "../src/lib/mermaid-theme.ts";

describe("buildMermaidThemeVariables", () => {
  it("maps our theme tokens onto mermaid's themeVariables keys", () => {
    const vars = buildMermaidThemeVariables(DEFAULT_THEME_TOKENS);
    expect(vars.background).toBe(DEFAULT_THEME_TOKENS.bgElevated);
    expect(vars.primaryColor).toBe(DEFAULT_THEME_TOKENS.bgInset);
    expect(vars.primaryTextColor).toBe(DEFAULT_THEME_TOKENS.text);
    expect(vars.primaryBorderColor).toBe(DEFAULT_THEME_TOKENS.border);
    expect(vars.lineColor).toBe(DEFAULT_THEME_TOKENS.border);
    expect(vars.fontFamily).toBe(DEFAULT_THEME_TOKENS.fontMono);
  });

  it("produces a different palette for a different set of tokens (dark vs. light)", () => {
    const light = buildMermaidThemeVariables({ ...DEFAULT_THEME_TOKENS, bg: "#f1ebdd", text: "#171512", border: "#1a1712" });
    const dark = buildMermaidThemeVariables(DEFAULT_THEME_TOKENS);
    expect(light.primaryTextColor).not.toBe(dark.primaryTextColor);
    expect(light.lineColor).not.toBe(dark.lineColor);
  });

  it("every value is a non-empty string (mermaid rejects undefined/empty themeVariables)", () => {
    const vars = buildMermaidThemeVariables(DEFAULT_THEME_TOKENS);
    for (const [key, value] of Object.entries(vars)) {
      expect(typeof value, `${key} should be a string`).toBe("string");
      expect(value.length, `${key} should be non-empty`).toBeGreaterThan(0);
    }
  });
});
