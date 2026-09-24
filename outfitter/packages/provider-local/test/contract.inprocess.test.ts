// InProcessProvider's adapter for the shared SandboxProvider contract suite (src/testing/contract.ts).
// The "world" needs a channel back from the spawned child that isn't the SandboxProvider interface
// itself: a tiny script writes what it received to a file keyed by its own RUN_ID (received(), for
// C1), and polls for a per-run "exit" file to decide when to call process.exit(0) on its own (for
// C3's "the agent exits by itself", as distinct from provider.stop()'s SIGTERM).

import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InProcessProvider } from "../src/in-process.js";
import { runProviderContract, type ContractInstance, type ContractWorld } from "../src/testing/contract.js";
import type { SandboxHandle, SandboxProvider } from "../src/types.js";

async function waitForFile(path: string, timeoutMs = 3_000, intervalMs = 20): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return undefined;
}

async function makeInProcessContract(): Promise<ContractInstance> {
  const dir = await mkdtemp(join(tmpdir(), "provider-local-contract-inprocess-"));
  const script = join(dir, "agent.js");
  // Plain CommonJS via node's built-in interop (agentdPath is just spawned with `node <path>`).
  await writeFile(
    script,
    [
      "const fs = require('fs');",
      "const path = require('path');",
      `const dir = ${JSON.stringify(dir)};`,
      "const runId = process.env.RUN_ID;",
      "fs.writeFileSync(path.join(dir, runId + '.received.json'), JSON.stringify({",
      "  runId: process.env.RUN_ID, runToken: process.env.RUN_TOKEN, apiOrigin: process.env.OUTFITTER_API,",
      "}));",
      "const exitPath = path.join(dir, runId + '.exit');",
      "const poll = setInterval(() => {",
      "  if (fs.existsSync(exitPath)) { clearInterval(poll); process.exit(0); }",
      "}, 20);",
      "",
    ].join("\n"),
  );

  const inner = new InProcessProvider({ agentdPath: script, piBin: "/bin/true" });
  const runIdByHandle = new Map<SandboxHandle, string>();

  // Wraps InProcessProvider only to remember which runId produced which handle, so the world can
  // find that run's files without InProcessProvider itself needing to know about this test.
  const provider: SandboxProvider = {
    async start(run) {
      const result = await inner.start(run);
      runIdByHandle.set(result.handle, run.runId);
      return result;
    },
    stop: (handle) => inner.stop(handle),
    status: (handle) => inner.status(handle),
  };

  const world: ContractWorld = {
    async received(handle) {
      const runId = runIdByHandle.get(handle);
      if (!runId) return undefined;
      const raw = await waitForFile(join(dir, `${runId}.received.json`));
      if (!raw) return undefined;
      return JSON.parse(raw);
    },
    async exitByItself(handle) {
      const runId = runIdByHandle.get(handle);
      if (!runId) return;
      await writeFile(join(dir, `${runId}.exit`), "1");
    },
  };

  return { provider, world };
}

runProviderContract("inprocess", makeInProcessContract);
