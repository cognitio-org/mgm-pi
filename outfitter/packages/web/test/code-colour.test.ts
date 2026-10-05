import { describe, expect, it } from "vitest";
import type { Element, Root } from "hast";
import { colourLanguage, rehypeCodeColour } from "../src/lib/rehype-code-colour.ts";

function fence(className: string | undefined, text: string, parentTag = "pre"): { tree: Root; code: Element } {
  const code: Element = {
    type: "element",
    tagName: "code",
    properties: className ? { className: [className] } : {},
    children: [{ type: "text", value: text }],
  };
  const tree: Root = { type: "root", children: [{ type: "element", tagName: parentTag, properties: {}, children: [code] }] };
  return { tree, code };
}

const run = (tree: Root) => rehypeCodeColour()(tree);
const classesIn = (node: Element): string[] =>
  node.children.flatMap((c) => (c.type === "element" ? [...((c.properties.className as string[]) ?? []), ...classesIn(c)] : []));

describe("colourLanguage", () => {
  it("knows the registered languages and their aliases", () => {
    expect(colourLanguage("language-ts")).toBe("ts");
    expect(colourLanguage("language-Python")).toBe("python");
    expect(colourLanguage("language-sh")).toBe("sh");
    expect(colourLanguage("language-yml")).toBe("yml");
  });

  it("leaves untagged, unknown, mermaid and html fences plain", () => {
    expect(colourLanguage("")).toBeUndefined();
    expect(colourLanguage("language-brainfuck")).toBeUndefined();
    expect(colourLanguage("language-mermaid")).toBeUndefined();
    expect(colourLanguage("language-html")).toBeUndefined();
  });
});

describe("rehypeCodeColour", () => {
  it("wraps tokens of a tagged fence in hljs-* spans and keeps the language class", () => {
    const { tree, code } = fence("language-ts", "const x = 1; // note");
    run(tree);
    expect(code.properties.className).toEqual(["hljs", "language-ts"]);
    const classes = classesIn(code);
    expect(classes).toContain("hljs-keyword");
    expect(classes).toContain("hljs-number");
    expect(classes).toContain("hljs-comment");
  });

  it("does nothing to inline code, untagged fences or mermaid", () => {
    for (const [cls, parent] of [
      ["language-ts", "p"],
      [undefined, "pre"],
      ["language-mermaid", "pre"],
    ] as const) {
      const { tree, code } = fence(cls, "const x = 1;", parent);
      run(tree);
      expect(code.children).toEqual([{ type: "text", value: "const x = 1;" }]);
    }
  });

  it("never produces raw HTML: markup in the source stays text", () => {
    const { tree, code } = fence("language-js", 'const s = "<img src=x onerror=alert(1)>";');
    run(tree);
    const json = JSON.stringify(code);
    expect(json).not.toContain('"type":"raw"');
    expect(json).toContain("<img src=x onerror=alert(1)>");
  });
});
