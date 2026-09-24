import type { Config } from "../config.ts";
import type { SandboxProvider } from "@outfitter/provider-local";
import { createProviders } from "./registry.ts";

export type { SandboxProvider, RunLaunch, SandboxHandle, SandboxStatus } from "@outfitter/provider-local";
export { NoopProvider } from "./noop.ts";
export { SandboxProviders, createProviders } from "./registry.ts";

/**
 * Builds the configured default SandboxProvider. A thin wrapper around the registry (registry.ts,
 * gke-sandbox-provider.md §2.4) so a caller that only ever wanted "the one configured provider"
 * (main.ts) doesn't need to change. `inprocess` and `docker` come from `@outfitter/provider-local`
 * (the same package `packages/provider-local` ships to its own consumers -- see EPIC.md E1.3 and
 * docs/reports/maintainability-review-pr1.md "Four SandboxProvider implementations"); this package
 * no longer keeps its own copies of either. Only SANDBOX_PROVIDER=cloudrun/gke import their cloud
 * SDKs, and they do so lazily (inside the registry's factories), so tests (which use NoopProvider
 * directly) never pay for it.
 */
export async function createProvider(config: Config): Promise<SandboxProvider> {
  return createProviders(config).get(config.sandboxProvider);
}
