// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { previewSandbox, previewSrcDoc, type PreviewAccess } from "../src/lib/html-preview.ts";

const CSP = "default-src 'none'";
const REMOTE = "https://evil.example/pixel.png";

function parsed(serialized: string): Document {
  return new DOMParser().parseFromString(serialized, "text/html");
}

/** Charset and the CSP meta are the first element children of head, not text inside a comment
 * or an attribute. */
function expectPolicy(serialized: string, access: PreviewAccess = "sealed"): Document {
  const doc = parsed(serialized);
  const kids = Array.from(doc.head.children);
  expect(kids[0]?.getAttribute("charset")).toBe("utf-8");
  expect(kids[1]?.tagName).toBe("META");
  expect(kids[1]?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
  const content = kids[1]?.getAttribute("content") ?? "";
  expect(content).toContain(CSP);
  if (access === "external") expect(content).toContain("script-src 'unsafe-inline' https: http:");
  else expect(content).not.toContain("script-src");
  return doc;
}

describe("previewSrcDoc", () => {
  it("wraps a fragment and puts the policy in the head", () => {
    const doc = previewSrcDoc('<div class="x">hi</div>');
    expect(doc.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(doc.indexOf(CSP)).toBeLessThan(doc.indexOf("<body>"));
    expect(doc).toContain('<div class="x">hi</div>');
    expectPolicy(doc);
  });

  it("injects the policy into an existing head, ahead of the page", () => {
    const doc = previewSrcDoc("<!DOCTYPE html><html><head><title>T</title><style>p{color:red}</style></head><body><p>Hi</p></body></html>");
    expect(doc.indexOf(CSP)).toBeLessThan(doc.indexOf("<title>"));
    expect(doc).toContain("<p>Hi</p>");
    const tree = expectPolicy(doc);
    expect(tree.head.querySelector("style")?.textContent).toBe("p{color:red}");
    expect(tree.querySelectorAll("style")).toHaveLength(1);
  });

  it("adds a head when the document has none", () => {
    const doc = previewSrcDoc("<html><body><h1>Spec</h1></body></html>");
    expect(doc).toContain(`<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"`);
    expect(doc).toContain("<h1>Spec</h1>");
    expectPolicy(doc);
  });

  it("refuses remote images, fonts, and network loads", () => {
    const doc = previewSrcDoc("<p>x</p>");
    expect(doc).toContain("img-src data:");
    expect(doc).toContain("font-src data:");
    expect(doc).toContain("form-action 'none'");
    expect(doc).toContain("base-uri 'none'");
    expect(doc).not.toContain("script-src");
    expect(previewSandbox("sealed")).toBe("");
  });

  it("allows http and https CSS and JS only when asked, and still withholds the parent page", () => {
    const doc = previewSrcDoc("<p>x</p>", "external");
    expect(doc).toContain("script-src 'unsafe-inline' https: http:");
    expect(doc).toContain("style-src 'unsafe-inline' https: http:");
    expect(doc).toContain("connect-src https: http:");
    expect(doc).toContain("form-action 'none'");
    expect(previewSandbox("external")).toBe("allow-scripts");
    expect(previewSandbox("external")).not.toContain("allow-same-origin");
    expectPolicy(doc, "external");
  });

  it("keeps the policy when a comment contains a head", () => {
    const doc = previewSrcDoc(
      `<!DOCTYPE html><!-- <head></head> --><html><body><!-- <head></head> --><img src="${REMOTE}"><p>Kept</p></body></html>`,
    );
    const tree = expectPolicy(doc);
    expect(doc).toContain("<!-- <head></head> -->");
    expect(doc).not.toContain(REMOTE);
    expect(tree.body.textContent).toContain("Kept");
    expect(tree.querySelector("img")?.hasAttribute("src")).toBe(false);
  });

  it("keeps the policy when a head attribute quotes a >", () => {
    const doc = previewSrcDoc(
      `<!DOCTYPE html><html><head foo=">${REMOTE}"></head><body><img src="${REMOTE}"><p>Kept</p></body></html>`,
    );
    const tree = expectPolicy(doc);
    expect(tree.head.hasAttribute("foo")).toBe(false);
    expect(doc).not.toContain(REMOTE);
    expect(tree.body.textContent).toContain("Kept");
  });

  it("keeps the policy when an image precedes html", () => {
    const doc = previewSrcDoc(
      `<!DOCTYPE html><img src="${REMOTE}"><html><head><style>p{color:red}</style></head><body><p>Kept</p><img src="data:image/gif;base64,AAAA"></body></html>`,
    );
    const tree = expectPolicy(doc);
    expect(doc).not.toContain(REMOTE);
    expect(tree.head.querySelector("style")?.textContent).toBe("p{color:red}");
    expect(tree.body.textContent).toContain("Kept");
    expect(doc).toContain("data:image/gif;base64,AAAA");
  });

  it("drops a refresh meta and a base", () => {
    const source = `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${REMOTE}"><base href="${REMOTE}/"></head><body><p>Stay</p><meta http-equiv="Refresh" content="0; URL=${REMOTE}"></body></html>`;
    const doc = previewSrcDoc(source);
    const tree = expectPolicy(doc);
    expect(doc).not.toContain(REMOTE);
    expect(doc.toLowerCase()).not.toContain("refresh");
    expect(tree.querySelector("base")).toBeNull();
    expect(tree.body.textContent).toContain("Stay");

    const external = previewSrcDoc(source, "external");
    const externalTree = expectPolicy(external, "external");
    expect(external.toLowerCase()).not.toContain("refresh");
    expect(externalTree.querySelector("base")).toBeNull();
    expect(external).not.toContain(REMOTE);
  });

  it("neutralizes links in sealed mode and keeps them when external", () => {
    const source = `<!DOCTYPE html><html><body><a href="${REMOTE}">go</a><map name="m"><area href="${REMOTE}" alt="spot"></map></body></html>`;
    const doc = previewSrcDoc(source);
    const tree = expectPolicy(doc);
    expect(doc).not.toContain(REMOTE);
    expect(tree.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(tree.querySelector("area")?.hasAttribute("href")).toBe(false);
    expect(tree.querySelector("a")?.textContent).toBe("go");

    const external = previewSrcDoc(
      `<!DOCTYPE html><html><head><base href="${REMOTE}/"><meta http-equiv="refresh" content="0;url=${REMOTE}"></head><body><a href="${REMOTE}">go</a><map name="m"><area href="${REMOTE}" alt="spot"></map></body></html>`,
      "external",
    );
    const externalTree = expectPolicy(external, "external");
    expect(externalTree.querySelector("a")?.getAttribute("href")).toBe(REMOTE);
    expect(externalTree.querySelector("area")?.getAttribute("href")).toBe(REMOTE);
    expect(externalTree.querySelector("base")).toBeNull();
    expect(external.toLowerCase()).not.toContain("http-equiv=\"refresh\"");
    expect(external).toContain("script-src 'unsafe-inline' https: http:");
    expect(previewSandbox("external")).toBe("allow-scripts");
    expect(previewSandbox("external")).not.toContain("allow-same-origin");
  });

  it("keeps head stylesheets and scripts only in external mode", () => {
    const source = `<link rel="stylesheet" href="${REMOTE}"><script src="${REMOTE}"></script><p>Hi</p>`;
    expect(previewSrcDoc(source)).not.toContain(REMOTE);
    const external = previewSrcDoc(source, "external");
    const tree = expectPolicy(external, "external");
    expect(tree.head.querySelector("link")?.getAttribute("href")).toBe(REMOTE);
    expect(tree.head.querySelector("script")?.getAttribute("src")).toBe(REMOTE);
    expect(external).toContain("script-src 'unsafe-inline' https: http:");
  });
});
