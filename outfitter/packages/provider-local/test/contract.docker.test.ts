// LocalDockerProvider's adapter for the shared SandboxProvider contract suite. Skipped (via
// makeProvider() rejecting) when there's no docker binary or daemon reachable -- see
// runProviderContract's doc comment on how a rejection turns into every case reporting skipped.
//
// The image built here is a plain shell loop as PID1 with a SIGTERM trap installed: a bare `sleep`
// (or any command with no signal handler) as a container's PID1 silently ignores an unhandled
// SIGTERM (the kernel's "unhandled signal to the namespace's init process is dropped" rule, the
// same reason a raw ENTRYPOINT binary often needs tini/dumb-init in real images) -- confirmed
// against the docker daemon this suite runs under before writing this file. Installing the trap
// is what lets world.exitByItself's `docker exec ... kill -TERM 1` actually terminate the
// container, modelling the agent process exiting on its own rather than being stopped externally.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalDockerProvider } from "../src/local-docker.js";
import { runProviderContract, type ContractInstance, type ContractWorld } from "../src/testing/contract.js";
import type { SandboxHandle } from "../src/types.js";

const execFileAsync = promisify(execFile);
const IMAGE_TAG = "outfitter-provider-contract:test";

const AGENT_SCRIPT = [
  "#!/bin/sh",
  "trap 'exit 0' TERM",
  "while true; do",
  "  sleep 1",
  "done",
  "",
].join("\n");

async function ensureContractImage(): Promise<void> {
  // Throws (skipping the whole suite) when the docker binary is missing or the daemon isn't
  // reachable -- both `docker info` and the build below need a real daemon, not just the CLI.
  await execFileAsync("docker", ["info"]);

  const dir = await mkdtemp(join(tmpdir(), "provider-local-contract-image-"));
  await writeFile(join(dir, "agent.sh"), AGENT_SCRIPT);
  await writeFile(join(dir, "Dockerfile"), "FROM alpine:3.20\nCOPY agent.sh /agent.sh\nRUN chmod +x /agent.sh\nCMD [\"/agent.sh\"]\n");
  await execFileAsync("docker", ["build", "-t", IMAGE_TAG, dir]);
}

async function readEnv(handle: SandboxHandle): Promise<Record<string, string>> {
  const { stdout } = await execFileAsync("docker", ["inspect", "-f", "{{json .Config.Env}}", handle]);
  const list: string[] = JSON.parse(stdout);
  const env: Record<string, string> = {};
  for (const entry of list) {
    const i = entry.indexOf("=");
    if (i > 0) env[entry.slice(0, i)] = entry.slice(i + 1);
  }
  return env;
}

async function makeDockerContract(): Promise<ContractInstance> {
  await ensureContractImage();

  const provider = new LocalDockerProvider({ defaultImage: IMAGE_TAG });
  const world: ContractWorld = {
    async received(handle) {
      const env = await readEnv(handle);
      return { runId: env.RUN_ID, runToken: env.RUN_TOKEN, apiOrigin: env.OUTFITTER_API };
    },
    async exitByItself(handle) {
      // Sends the signal the trap above catches, not provider.stop()'s "docker stop".
      await execFileAsync("docker", ["exec", handle, "kill", "-TERM", "1"]);
    },
  };
  return { provider, world };
}

runProviderContract("docker", makeDockerContract);
