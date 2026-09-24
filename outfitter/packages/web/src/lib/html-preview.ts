// Builds the srcdoc for the HTML preview dialog. The transcript never renders agent HTML
// into the page (Markdown.tsx). The preview is a separate document with its own policy.
//
// "sealed" (the default) allows inline CSS only. Remote stylesheets, scripts, images, and
// fonts are refused, so a preview cannot leak the viewer's address. "external" is the
// person's opt-in for a page that links out to CSS or JS: https and http loads are allowed,
// and the frame's sandbox gains allow-scripts. Neither mode sets allow-same-origin, so the
// frame still cannot read this page.
//
// The caller's markup is parsed and copied into a document we create. Searching the raw text
// for `<head>` is wrong: a comment, a quoted `>`, or an `<img>` before `<html>` can swallow
// the meta or leave it outside head, and sealed mode then still loads remote images. Charset
// and the CSP meta are the first children of our head. `navigate-to` is not implemented, so a
// refresh meta or a `<base>` would leave srcdoc and drop the policy; both are removed. Sealed
// mode also drops `<a>` and `<area>` navigations and remote subresource URLs. External mode
// may keep real links.

export type PreviewAccess = "sealed" | "external";

const XHTML = "http://www.w3.org/1999/xhtml";

const SEALED =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'";

const EXTERNAL =
  "default-src 'none'; style-src 'unsafe-inline' https: http:; script-src 'unsafe-inline' https: http:; img-src data: https: http:; font-src data: https: http:; media-src data: https: http:; connect-src https: http:; form-action 'none'; base-uri 'none'";

/** Attributes that load a subresource or navigate. Anchors are handled on their own: every href
 * leaves the srcdoc, including a fragment or a data URL. */
const URL_ATTRS = [
  "href", "src", "srcset", "action", "formaction", "poster", "cite", "background", "longdesc", "ping", "xlink:href",
] as const;

/** Sandbox token list. Empty means every restriction, including scripts. External adds
 * allow-scripts and nothing else: no same-origin, no top navigation, no popups. */
export function previewSandbox(access: PreviewAccess): string {
  return access === "external" ? "allow-scripts" : "";
}

function isDataUrl(value: string): boolean {
  return /^data:/i.test(value.replace(/^[\u0000-\u0020]+/, ""));
}

function srcsetIsData(value: string): boolean {
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 && parts.every((part) => isDataUrl(part.split(/\s+/)[0] ?? ""));
}

function isRefreshMeta(el: Element): boolean {
  return el.localName === "meta" && (el.getAttribute("http-equiv") ?? "").trim().toLowerCase() === "refresh";
}

/** A refresh meta navigates as soon as it is parsed. A `<base>` retargets every relative URL.
 * base-uri does not help once the frame has already left srcdoc, and navigate-to is not enforced. */
function dropRefreshAndBase(parsed: Document): void {
  for (const el of Array.from(parsed.querySelectorAll("base, meta"))) {
    if (el.localName === "base" || isRefreshMeta(el)) el.remove();
  }
}

/** Drop navigations and remote subresource URLs. data: images stay; the sealed policy allows them. */
function neutralizeSealed(root: ParentNode): void {
  for (const el of Array.from(root.querySelectorAll("*"))) {
    const anchor = el.localName === "a" || el.localName === "area";
    if (anchor) {
      el.removeAttribute("href");
      el.removeAttribute("xlink:href");
      el.removeAttribute("target");
      el.removeAttribute("ping");
    }
    for (const name of URL_ATTRS) {
      if (anchor && (name === "href" || name === "xlink:href" || name === "ping")) continue;
      if (!el.hasAttribute(name)) continue;
      const value = el.getAttribute(name) ?? "";
      if (name === "srcset" ? !srcsetIsData(value) : !isDataUrl(value)) el.removeAttribute(name);
    }
    const embedsRemote = el.localName === "object" || el.localName === "embed";
    if (embedsRemote && el.hasAttribute("data") && !isDataUrl(el.getAttribute("data") ?? "")) {
      el.removeAttribute("data");
    }
  }
}

function takeHtmlTitle(parsed: Document, head: HTMLHeadElement): void {
  for (const el of Array.from(parsed.querySelectorAll("title"))) {
    if (el.namespaceURI !== XHTML) continue;
    head.appendChild(head.ownerDocument.adoptNode(el));
    return;
  }
}

function takeHtmlStyles(parsed: Document, head: HTMLHeadElement): void {
  for (const el of Array.from(parsed.querySelectorAll("style"))) {
    if (el.namespaceURI !== XHTML) continue;
    head.appendChild(head.ownerDocument.adoptNode(el));
  }
}

/** Head stylesheets and scripts are not body contents. External mode is the opt-in that loads
 * them; they stay behind the CSP meta. Sealed mode does not copy them, so their URLs are absent. */
function takeExternalHeadResources(parsed: Document, head: HTMLHeadElement): void {
  for (const el of Array.from(parsed.head.children)) {
    if (el.namespaceURI !== XHTML) continue;
    if (el.localName !== "link" && el.localName !== "script") continue;
    head.appendChild(head.ownerDocument.adoptNode(el));
  }
}

/** A fragment or a full document both become a document we own. The caller's source is not
 * escaped and is not searched: the frame renders the tree the HTML parser produced. */
export function previewSrcDoc(source: string, access: PreviewAccess = "sealed"): string {
  const parsed = new DOMParser().parseFromString(source, "text/html");
  dropRefreshAndBase(parsed);

  const doc = document.implementation.createHTMLDocument();
  while (doc.head.firstChild) doc.head.firstChild.remove();

  const charset = doc.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  const csp = doc.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", access === "external" ? EXTERNAL : SEALED);
  doc.head.append(charset, csp);

  takeHtmlTitle(parsed, doc.head);
  takeHtmlStyles(parsed, doc.head);
  if (access === "external") takeExternalHeadResources(parsed, doc.head);
  if (access === "sealed" && parsed.body) neutralizeSealed(parsed.body);
  if (parsed.body) {
    while (parsed.body.firstChild) doc.body.appendChild(doc.adoptNode(parsed.body.firstChild));
  }

  return "<!DOCTYPE html>" + doc.documentElement.outerHTML;
}
