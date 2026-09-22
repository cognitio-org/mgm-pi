// SPA shell fallback rules (routes/static.ts): client routes get index.html, files and API paths 404.
import { test } from "node:test";
import assert from "node:assert/strict";
import { servesSpaShell } from "../src/routes/static.ts";

test("client-side routes get the SPA shell", () => {
  for (const url of ["/", "/fleet", "/sessions/abc-123", "/gurus?x=1", "/settings"]) assert.equal(servesSpaShell("GET", url), true, url);
});

test("assets, files, API and agent paths never get the shell", () => {
  for (const url of ["/assets/index-OLD.js", "/assets/x", "/favicon.ico", "/robots.txt", "/api/nope", "/agent/ws", "/sessions/a/b.map"]) {
    assert.equal(servesSpaShell("GET", url), false, url);
  }
});

test("only GET gets the shell", () => {
  assert.equal(servesSpaShell("POST", "/fleet"), false);
});
