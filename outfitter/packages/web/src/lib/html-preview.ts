// Builds the srcdoc for the HTML preview dialog. The transcript never renders agent HTML
// into the page (Markdown.tsx). The preview is a separate document with its own policy.
//
// "sealed" (the default) allows inline CSS only. Remote stylesheets, scripts, images, and
// fonts are refused, so a preview cannot leak the viewer's address. "external" is the
// person's opt-in for a page that links out to CSS or JS: https and http loads are allowed,
// and the frame's sandbox gains allow-scripts. Neither mode sets allow-same-origin, so the
// frame still cannot read this page.

export type PreviewAccess = "sealed" | "external";

const SEALED =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'";

const EXTERNAL =
  "default-src 'none'; style-src 'unsafe-inline' https: http:; script-src 'unsafe-inline' https: http:; img-src data: https: http:; font-src data: https: http:; media-src data: https: http:; connect-src https: http:; form-action 'none'; base-uri 'none'";

/** Sandbox token list. Empty means every restriction, including scripts. External adds
 * allow-scripts and nothing else: no same-origin, no top navigation, no popups. */
export function previewSandbox(access: PreviewAccess): string {
  return access === "external" ? "allow-scripts" : "";
}

function isFullDocument(source: string): boolean {
  return /^<!doctype\s+html/i.test(source) || /^<html[\s>]/i.test(source);
}

/** Insert our policy as the first thing in <head>, or add a <head> when the document has none.
 * A policy the document already carries still applies; two policies intersect, so the page
 * cannot widen ours. */
function injectCsp(doc: string, meta: string): string {
  if (/<head[^>]*>/i.test(doc)) return doc.replace(/<head[^>]*>/i, (open) => `${open}${meta}`);
  if (/<html[^>]*>/i.test(doc)) return doc.replace(/<html[^>]*>/i, (open) => `${open}<head>${meta}</head>`);
  return `<!DOCTYPE html><html><head>${meta}</head>${doc}</html>`;
}

/** A fragment is wrapped into a document. A full document keeps its markup, with our policy
 * added. The caller's source is not escaped: it is the document the frame renders. */
export function previewSrcDoc(source: string, access: PreviewAccess = "sealed"): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${access === "external" ? EXTERNAL : SEALED}">`;
  const trimmed = source.trim();
  if (isFullDocument(trimmed)) return injectCsp(trimmed, meta);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${meta}</head><body>\n${source}\n</body></html>`;
}
