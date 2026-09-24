import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAppendSystemPromptFile } from "../src/append-system.js";

test("discoverAppendSystemPromptFile: the workspace's .pi/APPEND_SYSTEM.md wins over the agent dir's", () => {
  const present = new Set(["/workspace/.pi/APPEND_SYSTEM.md", "/opt/kernal/.pi/APPEND_SYSTEM.md"]);
  assert.equal(
    discoverAppendSystemPromptFile("/workspace", "/opt/kernal/.pi", (p) => present.has(p)),
    "/workspace/.pi/APPEND_SYSTEM.md",
  );
});

test("discoverAppendSystemPromptFile: falls back to the agent dir, then to nothing", () => {
  const present = new Set(["/opt/kernal/.pi/APPEND_SYSTEM.md"]);
  assert.equal(
    discoverAppendSystemPromptFile("/workspace", "/opt/kernal/.pi", (p) => present.has(p)),
    "/opt/kernal/.pi/APPEND_SYSTEM.md",
  );
  assert.equal(discoverAppendSystemPromptFile("/workspace", "/opt/kernal/.pi", () => false), undefined);
  assert.equal(discoverAppendSystemPromptFile("/workspace", undefined, (p) => p.startsWith("/opt")), undefined);
});

test("discoverAppendSystemPromptFile: checks the real filesystem by default", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "agentd-append-"));
  assert.equal(discoverAppendSystemPromptFile(workspace, undefined), undefined);
  await mkdir(join(workspace, ".pi"));
  await writeFile(join(workspace, ".pi", "APPEND_SYSTEM.md"), "Repo rules.");
  assert.equal(discoverAppendSystemPromptFile(workspace, undefined), join(workspace, ".pi", "APPEND_SYSTEM.md"));
});
