// The kernal.one response headers live in security-headers.conf, included by every nginx location.
// These tests pin the ones that matter, and above all that the CSP's sha256 still matches the one
// inline script in index.html: edit that script without updating the hash and the browser silently
// refuses to run it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const conf = read("../security-headers.conf");
const html = read("../public/index.html");

function header(name) {
  const m = conf.match(new RegExp(`^add_header ${name} "([^"]*)" always;`, "m"));
  assert.ok(m, `security-headers.conf sets ${name} with "always"`);
  return m[1];
}

test("CSP pins exactly the inline scripts in index.html", () => {
  const csp = header("Content-Security-Policy");
  const pinned = [...csp.matchAll(/'sha256-([^']+)'/g)].map((m) => m[1]).sort();
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map((m) => createHash("sha256").update(m[1]).digest("base64"))
    .sort();
  assert.deepEqual(pinned, inline);
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /'unsafe-inline'|'unsafe-eval'/);
});

test("HSTS covers subdomains for a year, without preload", () => {
  const hsts = header("Strict-Transport-Security");
  assert.match(hsts, /max-age=31536000/);
  assert.match(hsts, /includeSubDomains/);
  assert.doesNotMatch(hsts, /preload/);
});

test("Permissions-Policy denies the powerful features and leaves audio alone", () => {
  const pp = header("Permissions-Policy");
  for (const f of ["camera", "microphone", "geolocation", "payment", "usb"]) assert.match(pp, new RegExp(`${f}=\\(\\)`));
  assert.doesNotMatch(pp, /autoplay/);
});

test("the basic hardening headers are all there", () => {
  assert.equal(header("X-Content-Type-Options"), "nosniff");
  assert.equal(header("X-Frame-Options"), "DENY");
  assert.equal(header("Referrer-Policy"), "strict-origin-when-cross-origin");
});
