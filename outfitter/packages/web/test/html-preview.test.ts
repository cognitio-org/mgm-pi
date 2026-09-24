import { describe, expect, it } from "vitest";
import { previewSandbox, previewSrcDoc } from "../src/lib/html-preview.ts";

const CSP = "default-src 'none'";

describe("previewSrcDoc", () => {
  it("wraps a fragment and puts the policy in the head", () => {
    const doc = previewSrcDoc('<div class="x">hi</div>');
    expect(doc.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(doc.indexOf(CSP)).toBeLessThan(doc.indexOf("<body>"));
    expect(doc).toContain('<div class="x">hi</div>');
  });

  it("injects the policy into an existing head, ahead of the page", () => {
    const doc = previewSrcDoc("<!DOCTYPE html><html><head><title>T</title></head><body><p>Hi</p></body></html>");
    expect(doc.indexOf(CSP)).toBeLessThan(doc.indexOf("<title>"));
    expect(doc).toContain("<p>Hi</p>");
  });

  it("adds a head when the document has none", () => {
    const doc = previewSrcDoc("<html><body><h1>Spec</h1></body></html>");
    expect(doc).toContain(`<head><meta http-equiv="Content-Security-Policy"`);
    expect(doc).toContain("<h1>Spec</h1>");
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
  });
});
