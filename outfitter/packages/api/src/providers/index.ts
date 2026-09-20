import type { Config } from "../config.ts";
import type { SandboxProvider } from "./types.ts";

export * from "./types.ts";
export { NoopProvider } from "./noop.ts";

/**
 * Builds the configured SandboxProvider. Only SANDBOX_PROVIDER=cloudrun imports @google-cloud/run,
 * and it does so lazily, so tests (which use NoopProvider directly) never pay for it.
 */
export async function createProvider(config: Config): Promise<SandboxProvider> {
  switch (config.sandboxProvider) {
    case "inprocess":
    case "docker": {
      // A dedicated docker provider is E1.3 (owned by provider-local); inprocess covers local dev
      // for this package until the two are unified.
      const { InProcessProvider } = await import("./inprocess.ts");
      return new InProcessProvider(config.origin);
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
