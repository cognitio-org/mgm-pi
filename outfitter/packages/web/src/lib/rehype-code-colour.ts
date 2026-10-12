// Syntax colouring for fenced code in the transcript: a small rehype plugin over lowlight
// (highlight.js grammars) that registers only lib/code-languages.ts. rehype-highlight does the
// same job but always bundles lowlight's 37-language "common" set, which doubled the session page.
//
// Only a fence with a language tag the set knows is coloured; untagged and unknown fences stay
// plain text (no auto-detect guessing). Mermaid and html fences are skipped so MermaidDiagram and
// HtmlFence still get their source as a string. Output is hast elements with hljs-* classes only,
// never raw HTML.

import type { Element, Root } from "hast";
import { toText } from "hast-util-to-text";
import { createLowlight } from "lowlight";
import { visit } from "unist-util-visit";
import { CODE_LANGUAGES } from "./code-languages.ts";
import { fenceLanguage } from "./mermaid-fence.ts";

const lowlight = createLowlight(CODE_LANGUAGES);

const SKIP = new Set(["mermaid", "html", "htm"]);

function classList(node: Element): string[] {
  const value: unknown = node.properties?.className;
  if (Array.isArray(value)) return value.map(String);
  return typeof value === "string" ? value.split(" ") : [];
}

/** The fence's registered language, or undefined when it should stay plain. */
export function colourLanguage(className: string): string | undefined {
  const lang = fenceLanguage(className)?.toLowerCase();
  if (!lang || SKIP.has(lang) || !lowlight.registered(lang)) return undefined;
  return lang;
}

export function rehypeCodeColour() {
  return (tree: Root) => {
    visit(tree, "element", (node, _index, parent) => {
      if (node.tagName !== "code" || !parent || parent.type !== "element" || parent.tagName !== "pre") return;
      const classes = classList(node);
      const lang = colourLanguage(classes.join(" "));
      if (!lang) return;
      const result = lowlight.highlight(lang, toText(node, { whitespace: "pre" }), { prefix: "hljs-" });
      node.properties.className = ["hljs", ...classes];
      if (result.children.length > 0) node.children = result.children as Element["children"];
    });
  };
}
