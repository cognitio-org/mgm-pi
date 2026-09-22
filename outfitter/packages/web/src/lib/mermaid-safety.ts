// Mermaid diagram source is untrusted model output (same trust boundary as Markdown.tsx). mermaid
// is initialised with securityLevel: "strict" (see MermaidDiagram.tsx), which already makes
// mermaid itself sanitize labels, drop click/callback bindings and refuse HTML labels -- but this
// module is a second, independent check on the rendered SVG string before it's ever inserted into
// the DOM, so a bug or future config change in mermaid doesn't silently reopen the hole. It's a
// pure string/DOM-parsing function (no mermaid import) so it can run and be tested without a real
// mermaid render -- see test/mermaid-safety.test.ts.

const UNSAFE_PATTERNS: RegExp[] = [
  /<script[\s>]/i,
  /<script$/i,
  /\bon[a-z]+\s*=/i, // onclick=, onerror=, onload=, ... as an attribute
  /javascript:/i,
  /<foreignobject[\s>]/i,
];

/** True if `svg` contains no script tags, event-handler attributes, javascript: URLs or
 * <foreignObject> (mermaid's own escape hatch for arbitrary HTML). Checked as a plain string scan
 * (cheap, works anywhere) rather than only a parsed-DOM walk, since a string that never reaches
 * the DOM parser as an element (e.g. inside an attribute value string) can't smuggle it in either
 * way -- but a substring match is deliberately the stricter, over-inclusive check. */
export function isSafeMermaidMarkup(svg: string): boolean {
  return !UNSAFE_PATTERNS.some((re) => re.test(svg));
}

/** True if `svg` parses as XML with a single root <svg> element and no parser error -- confirms
 * mermaid.render() actually produced an SVG document rather than some other markup (or a parse
 * failure) before we ever hand it to dangerouslySetInnerHTML. */
export function isSvgRoot(svg: string): boolean {
  if (typeof DOMParser === "undefined") return false;
  try {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    if (doc.getElementsByTagName("parsererror").length > 0) return false;
    return doc.documentElement?.tagName.toLowerCase() === "svg";
  } catch {
    return false;
  }
}

/** Combined gate a rendered diagram must pass before being inserted into the page. */
export function isSafeMermaidSvg(svg: string): boolean {
  return isSvgRoot(svg) && isSafeMermaidMarkup(svg);
}
