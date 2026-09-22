import { describe, it, expect } from "vitest";
import { codeChildrenToSource, fenceLanguage, isMermaidFence } from "../src/lib/mermaid-fence.ts";

describe("fenceLanguage / isMermaidFence", () => {
  it("extracts the language from a language-* className", () => {
    expect(fenceLanguage("language-ts")).toBe("ts");
    expect(fenceLanguage("language-mermaid")).toBe("mermaid");
  });

  it("is undefined for inline code (no className)", () => {
    expect(fenceLanguage(undefined)).toBeUndefined();
    expect(fenceLanguage(null)).toBeUndefined();
  });

  it("isMermaidFence is true only for language-mermaid", () => {
    expect(isMermaidFence("language-mermaid")).toBe(true);
    expect(isMermaidFence("language-ts")).toBe(false);
    expect(isMermaidFence(undefined)).toBe(false);
  });
});

describe("codeChildrenToSource", () => {
  it("passes through a plain string, dropping one trailing newline", () => {
    expect(codeChildrenToSource("flowchart TD\nA-->B\n")).toBe("flowchart TD\nA-->B");
  });

  it("keeps a string with no trailing newline as-is", () => {
    expect(codeChildrenToSource("flowchart TD\nA-->B")).toBe("flowchart TD\nA-->B");
  });

  it("joins an array of string children", () => {
    expect(codeChildrenToSource(["flowchart TD\n", "A-->B\n"])).toBe("flowchart TD\nA-->B");
  });

  it("ignores non-string entries in an array (e.g. nested elements)", () => {
    expect(codeChildrenToSource(["a\n", { type: "br" }, "b\n"])).toBe("a\nb");
  });

  it("handles null/undefined as empty source", () => {
    expect(codeChildrenToSource(undefined)).toBe("");
    expect(codeChildrenToSource(null)).toBe("");
  });
});
