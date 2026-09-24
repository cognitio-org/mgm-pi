/**
 * What the model is told about HTML it writes for the transcript's preview (issue #132). Exactly
 * one of these is appended to pi's system prompt on every start, so the model never has to guess:
 * the sealed one by default, the external one when the person allowed external CSS and JS.
 *
 * This file is the one place the text lives. The desktop reads it through the kernal-html-preview
 * extension; the Drive's agentd keeps a copy in outfitter/packages/agentd/src/html-preview-prompt.ts
 * (agentd builds on its own and cannot import from kernal), and agentd's test fails if the two
 * drift apart. Change both together.
 */
export const SEALED_HTML_PREVIEW_PROMPT =
  "When you write HTML for the person to read in the transcript, put it in a ```html fence. " +
  "Use only CSS written inside the document. Do not link stylesheets, scripts, images, or fonts. " +
  "The preview blocks those until the person allows them. " +
  "The preview cannot see this page or the session.";

export const EXTERNAL_HTML_PREVIEW_PROMPT =
  "When you write HTML for the person to read in the transcript, put it in a ```html fence. " +
  "External CSS and JavaScript are allowed: you may link http and https stylesheets, scripts, images, and fonts. " +
  "The preview still cannot see this page or the session.";

/** The paragraph to append for this setting. Anything but `true` is sealed. */
export function htmlPreviewPrompt(allowExternal: boolean | undefined): string {
  return allowExternal === true ? EXTERNAL_HTML_PREVIEW_PROMPT : SEALED_HTML_PREVIEW_PROMPT;
}
