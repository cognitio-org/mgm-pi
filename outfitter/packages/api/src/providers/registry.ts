// Provider registry (docs/specs/gke-sandbox-provider.md §2.4, gke-sandbox-provider-plan.md §5 item
// 4). Before this, `createProvider(config)` built exactly one SandboxProvider per process
// (providers/index.ts's old switch); a run's `providerHandle` alone couldn't say which provider
// made it (G1), and switching SANDBOX_PROVIDER meant runs already in flight under the old provider
// could no longer be stopped or reconciled (G2). SandboxProviders instead builds every *configured*
// provider lazily and keeps whichever ones get used, so a run keeps working with the provider that
// actually started it even after the deployment's default has moved on.

import type { Config, SandboxProviderName } from "../config.ts";
import type { SandboxProvider } from "@outfitter/provider-local";

export type SandboxProviderFactory = () => Promise<SandboxProvider>;

export class SandboxProviders {
  readonly defaultName: SandboxProviderName;
  private readonly factories: Partial<Record<SandboxProviderName, SandboxProviderFactory>>;
  private readonly built = new Map<SandboxProviderName, Promise<SandboxProvider>>();

  // Plain fields, not TS constructor-parameter properties: those aren't erasable syntax, so
  // `node --test` (which runs .ts test files directly via type-stripping, no build step -- see
  // api/package.json's `test` script) can't load a class that uses them.
  constructor(
    defaultName: SandboxProviderName,
    factories: Partial<Record<SandboxProviderName, SandboxProviderFactory>>,
  ) {
    this.defaultName = defaultName;
    this.factories = factories;
  }

  /** Lazily builds and memoizes. Throws `sandbox provider "<name>" is not configured here` if
   * `name` has no registered factory -- e.g. a run recorded a provider that this deployment no
   * longer configures after a SANDBOX_PROVIDER switch. Callers (runs.ts) catch this, log once, and
   * skip the provider call rather than fail the whole operation. */
  get(name: SandboxProviderName): Promise<SandboxProvider> {
    const existing = this.built.get(name);
    if (existing) return existing;
    const factory = this.factories[name];
    if (!factory) {
      return Promise.reject(new Error(`sandbox provider "${name}" is not configured here`));
    }
    // Wrapped in Promise.resolve().then(...) so a factory that throws synchronously (rather than
    // returning a rejected promise) is still memoized as a rejection, not re-thrown out of get().
    const building = Promise.resolve().then(factory);
    this.built.set(name, building);
    return building;
  }

  /** Test helper and back-compat: wrap one already-built provider as the default, so a caller
   * that only ever had a single SandboxProvider (main.ts's old shape, most existing tests) can
   * still hand RunManager something that satisfies the registry-shaped constructor. */
  static single(name: SandboxProviderName, provider: SandboxProvider): SandboxProviders {
    return new SandboxProviders(name, { [name]: async () => provider });
  }
}

async function buildInProcess(): Promise<SandboxProvider> {
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

async function buildDocker(): Promise<SandboxProvider> {
  const { LocalDockerProvider } = await import("@outfitter/provider-local");
  return new LocalDockerProvider({
    dockerBin: process.env.DOCKER_BIN,
    defaultImage: process.env.AGENT_IMAGE,
  });
}

async function buildCloudRun(config: Config): Promise<SandboxProvider> {
  const { CloudRunProvider } = await import("./cloudrun.ts");
  return new CloudRunProvider({
    project: config.gcpProject,
    region: config.gcpRegion,
    job: config.cloudRunJob,
  });
}

/** PR2 (gke-sandbox-provider-plan.md §3) adds the real GkeProvider; registering this factory now
 * (rather than leaving "gke" unregistered) means SANDBOX_PROVIDER=gke and a configured
 * GKE_CLUSTER already resolve through the registry today, and PR2 only has to replace this one
 * function's body. */
async function buildGke(_config: Config): Promise<SandboxProvider> {
  throw new Error(
    "SANDBOX_PROVIDER=gke has no provider implementation yet " +
      "(see docs/specs/gke-sandbox-provider-plan.md PR2)",
  );
}

function factoryFor(name: SandboxProviderName, config: Config): SandboxProviderFactory {
  switch (name) {
    case "inprocess":
      return buildInProcess;
    case "docker":
      return buildDocker;
    case "cloudrun":
      return () => buildCloudRun(config);
    case "gke":
      return () => buildGke(config);
  }
}

/**
 * Registers a factory for the configured default provider, plus any *other* cloud provider whose
 * own config is present -- cloudrun when gcpProject and cloudRunJob are set, gke when gcpProject
 * and gkeCluster are set (spec §2.4) -- so runs already in flight under the previous default stay
 * stoppable/reconcilable after a SANDBOX_PROVIDER switch (§2.6). Local dev providers (inprocess,
 * docker) are only ever registered as the default: they have no "was this configured" signal of
 * their own, and switching away from one mid-flight isn't a real deployment scenario.
 */
export function createProviders(config: Config): SandboxProviders {
  const factories: Partial<Record<SandboxProviderName, SandboxProviderFactory>> = {
    [config.sandboxProvider]: factoryFor(config.sandboxProvider, config),
  };

  if (config.gcpProject && config.cloudRunJob && !factories.cloudrun) {
    factories.cloudrun = factoryFor("cloudrun", config);
  }
  if (config.gcpProject && config.gkeCluster && !factories.gke) {
    factories.gke = factoryFor("gke", config);
  }

  return new SandboxProviders(config.sandboxProvider, factories);
}
