/**
 * End-to-end smoke test: runs the real agent against each backend. Needs LM Studio running,
 * keys in ~/localllm/.env and network. Opt in with MGM_E2E=1 (npm run test:e2e).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const enabled = process.env.MGM_E2E === "1";
const envFile = join(homedir(), "localllm", ".env");
const hasOpenRouterKey = !!process.env.OPENROUTER_API_KEY || (existsSync(envFile) && /^OPENROUTER_API_KEY=sk-or-\S+/m.test(readFileSync(envFile, "utf8")));
const run = (model: string, prompt: string) =>
  execFileSync(join(root, "bin", "mgm"), ["-p", "--no-session", "--model", model, prompt], { encoding: "utf8", timeout: 180_000, cwd: root }).trim();

describe("e2e (MGM_E2E=1)", { skip: !enabled && "set MGM_E2E=1 to run" }, () => {
  test("model listing includes all three providers", () => {
    const out = execFileSync(join(root, "bin", "mgm"), ["--list-models"], { encoding: "utf8", timeout: 120_000, cwd: root });
    for (const p of ["lmstudio", "litellm", "openrouter"]) assert.match(out, new RegExp(`^${p}\\s`, "m"), p);
  });
  test("lmstudio answers with thinking off", () => {
    assert.equal(run("lmstudio/qwen/qwen3.6-35b-a3b", "Reply with exactly: ok").split("\n").at(-1), "ok");
  });
  test("litellm cloud route answers", () => {
    assert.equal(run("litellm/claude-haiku-4-5", "Reply with exactly: ok").split("\n").at(-1), "ok");
  });
  test("litellm local route with thinking on still answers", () => {
    assert.match(run("litellm/local-qwen-mlx:low", "What is 17*23? Answer with the number only."), /391/);
  });
  test("openrouter answers", { skip: !hasOpenRouterKey && "no OPENROUTER_API_KEY" }, () => {
    assert.equal(run("openrouter/anthropic/claude-sonnet-5", "Reply with exactly: ok").split("\n").at(-1), "ok");
  });
});
