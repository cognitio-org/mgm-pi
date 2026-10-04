// The privacy policy and terms pages (/privacy/, /terms/), made by tools/legal-pages.py.
// Run with: node --test outfitter/landing/test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const csp = read("security-headers.conf").match(/Content-Security-Policy "([^"]+)"/)[1];
const inlineScripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const hash = (s) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`;

for (const page of ["privacy", "terms"]) {
  const html = read(`public/${page}/index.html`);

  test(`/${page}/: every inline script is allowed by the CSP hash`, () => {
    const scripts = inlineScripts(html);
    assert.equal(scripts.length, 1, "only the theme script");
    assert.ok(csp.includes(hash(scripts[0])), "theme script differs from index.html's: re-run tools/legal-pages.py");
    assert.ok(!/<script\s+src=/.test(html), "no external scripts");
    assert.ok(!/\sstyle=/.test(html), "style-src 'self' allows no inline style attributes");
  });

  test(`/${page}/: titled, linked to the other page, styled from /style.css`, () => {
    assert.match(html, /<title>(Privacy Policy|Terms of Use) · Kernal<\/title>/);
    assert.ok(html.includes('href="/privacy/"') && html.includes('href="/terms/"'));
    assert.ok(html.includes('<link rel="stylesheet" href="/style.css">'));
  });
}

test("the home page footer links both pages", () => {
  const index = read("public/index.html");
  assert.ok(index.includes('href="/privacy/"') && index.includes('href="/terms/"'));
});

test("the generator is in step with the committed pages", async () => {
  const { execFileSync } = await import("node:child_process");
  const before = ["privacy", "terms"].map((p) => read(`public/${p}/index.html`));
  execFileSync("python3", [new URL("../tools/legal-pages.py", import.meta.url).pathname]);
  assert.deepEqual(["privacy", "terms"].map((p) => read(`public/${p}/index.html`)), before, "edit tools/legal-pages.py, not the HTML");
});
