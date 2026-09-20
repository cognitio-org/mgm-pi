import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InProcessProvider } from "../src/in-process.js";

async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("InProcessProvider: start reports running, stop reports exited", async () => {
  const dir = await mkdtemp(join(tmpdir(), "provider-local-test-"));
  const script = join(dir, "long-lived.js");
  // Reads env vars it was given and just idles; agentd's real entry point is out of scope here --
  // this only exercises the provider's process lifecycle plumbing.
  await writeFile(script, "setInterval(() => {}, 1000);\n");

  const provider = new InProcessProvider({ agentdPath: script, piBin: "/bin/true" });
  const { handle } = await provider.start({ runId: "r1", apiOrigin: "http://localhost:9", runToken: "test-run-token" });

  await waitFor(async () => (await provider.status(handle)) === "running");
  assert.equal(await provider.status(handle), "running");

  await provider.stop(handle);
  await waitFor(async () => (await provider.status(handle)) === "exited");
  assert.equal(await provider.status(handle), "exited");
});

test("InProcessProvider: status of an unknown handle is 'exited'", async () => {
  const provider = new InProcessProvider({ agentdPath: "/nonexistent.js", piBin: "/bin/true" });
  assert.equal(await provider.status("no-such-handle"), "exited");
});
