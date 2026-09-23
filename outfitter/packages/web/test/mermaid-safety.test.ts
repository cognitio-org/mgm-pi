// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { isSafeMermaidMarkup, isSafeMermaidSvg, isSvgRoot } from "../src/lib/mermaid-safety.ts";

// mermaid can't actually render inside vitest's jsdom environment (it calls SVG layout APIs --
// getBBox and friends -- that jsdom doesn't implement; a real mermaid.render() call throws
// "getBBox is not a function" even for a trivial diagram). So instead of driving a real render,
// these tests exercise the sanitizing gate directly against SVG strings shaped like what a
// securityLevel: "strict" mermaid render would (or, for the attack cases, would NOT) produce --
// verifying the gate itself catches script tags, event-handler attributes, javascript: URLs and
// HTML-in-labels-via-foreignObject if any of them were ever present in a rendered string.

const CLEAN_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50">
  <g class="node"><rect width="80" height="30" x="10" y="10"/><text x="20" y="25">Hello</text></g>
</svg>`;

describe("isSvgRoot", () => {
  it("is true for a well-formed <svg> document", () => {
    expect(isSvgRoot(CLEAN_SVG)).toBe(true);
  });

  it("is false for non-SVG markup", () => {
    expect(isSvgRoot("<div>not an svg</div>")).toBe(false);
  });

  it("is false for malformed XML", () => {
    expect(isSvgRoot("<svg><rect></svg>")).toBe(false);
  });
});

describe("isSafeMermaidMarkup", () => {
  it("passes clean SVG output", () => {
    expect(isSafeMermaidMarkup(CLEAN_SVG)).toBe(true);
  });

  it("rejects a <script> tag (e.g. a diagram source containing raw <script>)", () => {
    const svg = `<svg><text>hi</text><script>alert(document.cookie)</script></svg>`;
    expect(isSafeMermaidMarkup(svg)).toBe(false);
  });

  it("rejects event-handler attributes (a click callback leaking into the output)", () => {
    const svg = `<svg><g onclick="alert(1)"><rect/></g></svg>`;
    expect(isSafeMermaidMarkup(svg)).toBe(false);
  });

  it("rejects javascript: URLs (a diagram source with a javascript: link)", () => {
    const svg = `<svg><a href="javascript:alert(1)"><text>click</text></a></svg>`;
    expect(isSafeMermaidMarkup(svg)).toBe(false);
  });

  it("rejects <foreignObject> (mermaid's own HTML-label escape hatch)", () => {
    const svg = `<svg><foreignObject><div>raw html label</div></foreignObject></svg>`;
    expect(isSafeMermaidMarkup(svg)).toBe(false);
  });

  it("rejects an entity-encoded javascript: URL (the HTML parser decodes it before use)", () => {
    const svg = `<svg><a href="&#106;avascript:alert(1)"><text>click</text></a></svg>`;
    expect(isSafeMermaidMarkup(svg)).toBe(false);
    expect(isSafeMermaidMarkup(`<svg><a xlink:href=" java\tscript:alert(1)"><text>x</text></a></svg>`)).toBe(false);
  });

  it("rejects HTML that breaks out of the SVG", () => {
    expect(isSafeMermaidMarkup(`<svg><text>x</text></svg><img src="x">`)).toBe(false);
  });

  it("accepts a diagram whose label *text* merely mentions on*= or javascript:", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>once=1, onload = x, see javascript: URLs</text></svg>`;
    expect(isSafeMermaidMarkup(svg)).toBe(true);
    expect(isSafeMermaidSvg(svg)).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isSafeMermaidMarkup(`<svg><SCRIPT>evil()</SCRIPT></svg>`)).toBe(false);
    expect(isSafeMermaidMarkup(`<svg><a HREF="JAVASCRIPT:evil()">x</a></svg>`)).toBe(false);
  });
});

describe("isSafeMermaidSvg (combined gate used before dangerouslySetInnerHTML)", () => {
  it("accepts a clean, well-formed SVG", () => {
    expect(isSafeMermaidSvg(CLEAN_SVG)).toBe(true);
  });

  it("rejects a diagram containing a <script>, even if the root parses as svg", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><script>fetch('https://evil.example')</script></svg>`;
    expect(isSafeMermaidSvg(svg)).toBe(false);
  });

  it("rejects a diagram with an onerror handler embedded via a label", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><image onerror="alert(1)" href="x"/></svg>`;
    expect(isSafeMermaidSvg(svg)).toBe(false);
  });

  it("rejects a diagram whose root is not <svg> (defense in depth even if markup looks clean)", () => {
    expect(isSafeMermaidSvg(`<div class="node">Hello</div>`)).toBe(false);
  });
});
