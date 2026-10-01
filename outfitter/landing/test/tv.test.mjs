// Tests for public/tv.js, the "Dear Sysop" TV on the home page. The DOM parts are driven in a real
// browser by hand; these pin the decisions it makes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

await import(fileURLToPath(new URL("../public/tv.js", import.meta.url)));
const TV = globalThis.KernalTV;

test("the little TV plays by itself only when that's cheap and wanted", () => {
  assert.equal(TV.shouldPreview({}), true);
  assert.equal(TV.shouldPreview({ effectiveType: "4g" }), true);
  assert.equal(TV.shouldPreview({ type: "wifi", effectiveType: "4g" }), true);
  assert.equal(TV.shouldPreview({ reduced: true }), false);
  assert.equal(TV.shouldPreview({ saveData: true }), false);
  assert.equal(TV.shouldPreview({ type: "cellular" }), false);
  assert.equal(TV.shouldPreview({ effectiveType: "3g" }), false);
  assert.equal(TV.shouldPreview({ effectiveType: "slow-2g" }), false);
  assert.equal(TV.shouldPreview({ effectiveType: "2g" }), false);
});

test("the MTV credit shows after the logo, for a few seconds", () => {
  assert.equal(TV.captionVisible(0), false);
  assert.equal(TV.captionVisible(3.0), false);
  assert.equal(TV.captionVisible(3.5), true);
  assert.equal(TV.captionVisible(9.8), true);
  assert.equal(TV.captionVisible(10), false);
});

test("the running time reads like a tape label", () => {
  assert.equal(TV.clock(86.4), "1:26");
  assert.equal(TV.clock(59.6), "1:00");
  assert.equal(TV.clock(5), "0:05");
  assert.equal(TV.clock(NaN), "");
  assert.equal(TV.clock(Infinity), "");
  assert.equal(TV.clock(0), "");
});

test("without a page it does nothing, and says the video isn't there", () => {
  assert.equal(TV.available(), false);
  assert.equal(TV.open(), false);
});

test("the page loads tv.js and the set stays hidden until its video is there", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<script src="\/tv\.js" defer><\/script>\s*<script src="\/app\.js" defer><\/script>/);
  assert.match(html, /<figure class="tv" id="tv" hidden data-no-greet>/);
  assert.match(html, /<dialog class="tv-dialog" id="tv-dialog"[^>]*data-no-greet>/);
  assert.match(html, /<video class="tv-picture" id="tv-small" muted loop playsinline/);
  assert.match(html, /<video id="tv-big" controls playsinline preload="none">/);
});
