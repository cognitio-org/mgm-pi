// Mermaid diagram source is untrusted model output (same trust boundary as Markdown.tsx). mermaid
// is initialised with securityLevel: "strict" (see MermaidDiagram.tsx), which already makes
// mermaid itself sanitize labels, drop click/callback bindings and refuse HTML labels -- but this
// module is a second, independent check on the rendered SVG string before it's ever inserted into
// the DOM, so a bug or future config change in mermaid doesn't silently reopen the hole. It's a
// pure string/DOM-parsing function (no mermaid import) so it can run and be tested without a real
// mermaid render -- see test/mermaid-safety.test.ts.

const SVG_NS = "http://www.w3.org/2000/svg";
const URL_ATTRS = new Set(["href", "xlink:href", "src", "action", "formaction"]);

/** True if `svg` contains no <script>, no <foreignObject> (mermaid's escape hatch for arbitrary
 * HTML), no element outside the SVG namespace (HTML that broke out of the SVG), no on*= event
 * handler attribute and no javascript:/vbscript: link.
 *
 * Checked on the parsed tree, with the *HTML* parser -- the same parser dangerouslySetInnerHTML
 * will use, so there's no parser differential to hide in and character references such as
 * `&#106;avascript:` are already decoded. (An earlier version regex-scanned the raw string: that
 * missed entity-encoded URLs and rejected harmless diagrams whose label *text* merely read
 * "once=1" or "javascript:".) */
export function isSafeMermaidMarkup(svg: string): boolean {
  if (typeof DOMParser === "undefined") return false;
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(`<!doctype html><body>${svg}`, "text/html");
  } catch {
    return false;
  }
  for (const el of Array.from(doc.body.querySelectorAll("*"))) {
    if (el.namespaceURI !== SVG_NS) return false;
    const tag = el.localName.toLowerCase();
    if (tag === "script" || tag === "foreignobject") return false;
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith("on")) return false;
      if (URL_ATTRS.has(name)) {
        // Browsers ignore ASCII whitespace/control characters inside a URL scheme.
        const value = attr.value.replace(/[\u0000-\u0020\u007f]/g, "").toLowerCase();
        if (/^(javascript|vbscript):/.test(value)) return false;
      }
    }
  }
  return true;
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
