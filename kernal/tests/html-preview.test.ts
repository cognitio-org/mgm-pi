import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makePi, tmpAgentDir } from "./harness.ts";
import {
  EXTERNAL_HTML_PREVIEW_PROMPT,
  SEALED_HTML_PREVIEW_PROMPT,
} from "../.pi/extensions/_shared/html-preview-prompt.ts";
import mod, { allowExternalHtmlResources, withHtmlPreviewPrompt } from "../.pi/extensions/kernal-html-preview/index.ts";

/** Loads the extension against a settings.json and runs one before_agent_start. */
async function appendedFor(settings: unknown, appendSystemPrompt = "") {
  tmpAgentDir(settings);
  const pi = makePi();
  mod(pi as any);
  const event = { systemPromptOptions: { appendSystemPrompt } };
  await pi.emit("before_agent_start", event, {});
  return event.systemPromptOptions.appendSystemPrompt;
}

afterEach(() => { delete process.env.KERNAL_SANDBOX; });

describe("kernal-html-preview (#132)", () => {
  test("the setting defaults off: absent, false, or anything but true", () => {
    assert.equal(allowExternalHtmlResources({}), false);
    assert.equal(allowExternalHtmlResources({ kernal: {} }), false);
    assert.equal(allowExternalHtmlResources({ kernal: { allowExternalHtmlResources: false } }), false);
    assert.equal(allowExternalHtmlResources({ kernal: { allowExternalHtmlResources: "true" } }), false);
    assert.equal(allowExternalHtmlResources({ kernal: { allowExternalHtmlResources: true } }), true);
  });

  test("the shipped settings.json leaves it off", () => {
    const shipped = JSON.parse(readFileSync(new URL("../.pi/settings.json", import.meta.url), "utf8"));
    assert.equal(allowExternalHtmlResources(shipped), false);
  });

  test("appends the sealed paragraph unless the setting is true", async () => {
    assert.equal(await appendedFor({}), SEALED_HTML_PREVIEW_PROMPT);
    assert.equal(await appendedFor({ kernal: { allowExternalHtmlResources: false } }), SEALED_HTML_PREVIEW_PROMPT);
    assert.equal(await appendedFor({ kernal: { allowExternalHtmlResources: true } }), EXTERNAL_HTML_PREVIEW_PROMPT);
  });

  test("keeps what --append-system-prompt or APPEND_SYSTEM.md already put there, in front", async () => {
    assert.equal(
      await appendedFor({ kernal: { allowExternalHtmlResources: true } }, "Always cite files."),
      `Always cite files.\n\n${EXTERNAL_HTML_PREVIEW_PROMPT}`,
    );
    assert.equal(withHtmlPreviewPrompt(undefined, false), SEALED_HTML_PREVIEW_PROMPT);
  });

  test("a prompt an earlier handler already forced (pi-memory does) gets the paragraph on its end", async () => {
    tmpAgentDir({ kernal: { allowExternalHtmlResources: true } });
    const pi = makePi();
    mod(pi as any);
    const event = { systemPromptOptions: { appendSystemPrompt: "", forceSystemPrompt: "base prompt\n\n## Memory\nnotes" } };
    await pi.emit("before_agent_start", event, {});
    assert.equal(event.systemPromptOptions.forceSystemPrompt, `base prompt\n\n## Memory\nnotes\n\n${EXTERNAL_HTML_PREVIEW_PROMPT}`);
    assert.equal(event.systemPromptOptions.appendSystemPrompt, EXTERNAL_HTML_PREVIEW_PROMPT);
  });

  test("never touches APPEND_SYSTEM.md", async () => {
    const { dir } = tmpAgentDir({ kernal: { allowExternalHtmlResources: true } });
    const pi = makePi();
    mod(pi as any);
    await pi.emit("before_agent_start", { systemPromptOptions: { appendSystemPrompt: "" } }, {});
    assert.equal(existsSync(join(dir, "APPEND_SYSTEM.md")), false);
  });

  test("reads the setting once at start: a later change applies to the next start", async () => {
    const store = tmpAgentDir({});
    const pi = makePi();
    mod(pi as any);
    writeFileSync(join(store.dir, "settings.json"), JSON.stringify({ kernal: { allowExternalHtmlResources: true } }));
    const event = { systemPromptOptions: { appendSystemPrompt: "" } };
    await pi.emit("before_agent_start", event, {});
    assert.equal(event.systemPromptOptions.appendSystemPrompt, SEALED_HTML_PREVIEW_PROMPT);
  });

  test("does nothing in an Outfitter Drive, where agentd appends the paragraph", async () => {
    process.env.KERNAL_SANDBOX = "1";
    tmpAgentDir({});
    const pi = makePi();
    mod(pi as any);
    assert.equal(pi.handlers.get("before_agent_start"), undefined);
  });
});
