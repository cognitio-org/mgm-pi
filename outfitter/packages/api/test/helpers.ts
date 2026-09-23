// Shared test scaffolding: an app wired to MemoryStore + NoopProvider in dev mode, so route,
// agentlink and auth tests never touch Mongo, a real provider, or GCP.

import { loadConfig } from "../src/config.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Store, Guru } from "../src/store/types.ts";
import { NoopProvider } from "../src/providers/noop.ts";
import { MemorySecretsBroker, MemorySecretAdmin, type SecretsBroker, type SecretAdmin } from "../src/secrets.ts";
import type { GithubBroker } from "../src/github-broker.ts";
import { buildApp, type App } from "../src/server.ts";

export interface TestApp extends App {
  store: Store;
  provider: NoopProvider;
}

export interface BuildTestAppOptions {
  /** Defaults to a MemorySecretsBroker; pass a stub to exercise agentlink.ts's handling of a
   * broker that returns empty/partial secrets. */
  secretsBroker?: SecretsBroker;
  /** Defaults to a fresh MemorySecretAdmin; share one across two buildTestApp calls (like `store`
   * below) to see writes from one role's app reflected in another's. */
  secretAdmin?: SecretAdmin;
  /** Share a store across two buildTestApp calls, e.g. to simulate the web/link role split
   * against one Atlas-like store in a test. Defaults to a fresh MemoryStore. */
  store?: Store;
  /** GitHub broker handed to AgentLink. Defaults to one that talks to api.github.com. */
  github?: GithubBroker;
}

export async function buildTestApp(
  envOverrides: Record<string, string> = {},
  opts: BuildTestAppOptions = {},
): Promise<TestApp> {
  const config = loadConfig({
    OUTFITTER_DEV: "1",
    OUTFITTER_DEV_TOKEN: "test-agent-token",
    AGENT_SA_EMAIL: "agent@test.local",
    MONGODB_URI: "memory",
    ...envOverrides,
  } as NodeJS.ProcessEnv);
  const store = opts.store ?? new MemoryStore();
  const provider = new NoopProvider();
  const secretsBroker = opts.secretsBroker ?? new MemorySecretsBroker();
  const secretAdmin = opts.secretAdmin ?? new MemorySecretAdmin();
  const app = await buildApp({ store, config, provider, secretsBroker, secretAdmin, github: opts.github });
  await app.fastify.ready();
  return { ...app, store, provider };
}

export async function seedGuru(store: Store, overrides: Partial<Guru> = {}): Promise<Guru> {
  const now = new Date().toISOString();
  const guru: Guru = {
    id: "test-guru",
    name: "Test Guru",
    model: "provider/model",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  await store.gurus.insert(guru);
  return guru;
}
