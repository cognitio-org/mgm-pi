import type { Config } from "../config.ts";
import type { SandboxProvider } from "@outfitter/provider-local";

export type { SandboxProvider, RunLaunch, SandboxHandle, SandboxStatus } from "@outfitter/provider-local";
export { NoopProvider } from "./noop.ts";

/**
 * Builds the configured SandboxProvider. `inprocess` and `docker` come from `@outfitter/
 * provider-local` (the same package `packages/provider-local` ships to its own consumers -- see
 * EPIC.md E1.3 and docs/reports/maintainability-review-pr1.md "Four SandboxProvider
 * implementations"); this package no longer keeps its own copies of either. Only
 * SANDBOX_PROVIDER=cloudrun imports @google-cloud/run, and it does so lazily, so tests (which use
 * NoopProvider directly) never pay for it.
 */
export async function createProvider(config: Config): Promise<SandboxProvider> {
  switch (config.sandboxProvider) {
    case "inprocess": {
      const { InProcessProvider } = await import("@outfitter/provider-local");
      const agentdPath = process.env.AGENTD_MAIN;
      if (!agentdPath) {
        throw new Error("AGENTD_MAIN is not set; required for SANDBOX_PROVIDER=inprocess");
      }
      return new InProcessProvider({
        agentdPath,
        piBin: process.env.PI_BIN ?? "pi",
        piCodingAgentDir: process.env.PI_CODING_AGENT_DIR,
        workspace: process.env.WORKSPACE,
      });
    }
    case "docker": {
      const { LocalDockerProvider } = await import("@outfitter/provider-local");
      return new LocalDockerProvider({
        dockerBin: process.env.DOCKER_BIN,
        defaultImage: process.env.AGENT_IMAGE,
      });
    }
    case "cloudrun": {
      const { CloudRunProvider } = await import("./cloudrun.ts");
      return new CloudRunProvider({
        project: config.gcpProject,
        region: config.gcpRegion,
        job: config.cloudRunJob,
        apiOrigin: config.origin,
      });
    }
    default:
      throw new Error(`unknown SANDBOX_PROVIDER: ${config.sandboxProvider}`);
  }
}
