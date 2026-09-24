import { test } from "node:test";
import assert from "node:assert/strict";
import * as copy from "../src/html-preview-prompt.js";

// Runs from dist/test, so the repo root is five levels up. Node strips the kernal file's types
// itself; the specifier is built at run time so tsc does not try to compile a file outside rootDir.
const KERNAL_SOURCE = new URL("../../../../../kernal/.pi/extensions/_shared/html-preview-prompt.ts", import.meta.url);

test("html-preview-prompt: agentd's copy matches kernal's, word for word", async () => {
  const kernal = await import(KERNAL_SOURCE.href);
  assert.equal(copy.SEALED_HTML_PREVIEW_PROMPT, kernal.SEALED_HTML_PREVIEW_PROMPT);
  assert.equal(copy.EXTERNAL_HTML_PREVIEW_PROMPT, kernal.EXTERNAL_HTML_PREVIEW_PROMPT);
});

test("html-preview-prompt: anything but true is sealed", () => {
  assert.equal(copy.htmlPreviewPrompt(undefined), copy.SEALED_HTML_PREVIEW_PROMPT);
  assert.equal(copy.htmlPreviewPrompt(false), copy.SEALED_HTML_PREVIEW_PROMPT);
  assert.equal(copy.htmlPreviewPrompt(true), copy.EXTERNAL_HTML_PREVIEW_PROMPT);
});
