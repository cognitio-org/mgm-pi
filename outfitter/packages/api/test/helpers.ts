// Shared test scaffolding: an app wired to MemoryStore + NoopProvider in dev mode, so route,
// agentlink and auth tests never touch Mongo, a real provider, or GCP.

import assert from "node:assert/strict";
import type { NgrokApi } from "../src/ngrok-api.ts";
import { FakeAgentEngine } from "./fake-agent-engine.ts";
import { createAgentEngine } from "../src/agentengine/index.ts";
import { hashToken } from "../src/tokens.ts";
import { loadConfig, type SandboxProviderName } from "../src/config.ts";
import { MemoryStore } from "../src/store/memory.ts";
import type { Store, Guru } from "../src/store/types.ts";
import { NoopProvider } from "../src/providers/noop.ts";
import { AppSecretCache, MemorySecretsBroker, MemorySecretAdmin, type SecretsBroker, type SecretAdmin } from "../src/secrets.ts";
import type { GithubBroker } from "../src/github-broker.ts";
import { buildApp, type App } from "../src/server.ts";
import type { SandboxProvider } from "@outfitter/provider-local";
import { SandboxProviders } from "../src/providers/registry.ts";
import type { GithubRefreshTiming } from "../src/agentlink.ts";
import type { SandboxTelemetry } from "../src/sandbox-telemetry.ts";
import type { VoiceService } from "../src/voice.ts";
import type { VoiceUsage } from "../src/voice-usage.ts";
import type { GithubCatalog } from "../src/github-catalog.ts";
import type { AgentEngine } from "../src/agentengine/index.ts";
import type { A2AHandlerFactory } from "../src/a2a/handler.ts";

export interface TestApp extends App {
  store: Store;
  provider: NoopProvider;
  secretAdmin: SecretAdmin;
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
  /** Extra provider factories registered alongside the default NoopProvider (e.g. a stub
   * GkeProvider under "gke", for hooks.test.ts's warm-pool route) -- see registry.ts's
   * createProviders. Keyed by SandboxProviderName; the default provider is always NoopProvider. */
  extraProviders?: Partial<Record<SandboxProviderName, () => Promise<SandboxProvider>>>;
  /** Shortens installation-token refresh waits. */
  githubRefresh?: GithubRefreshTiming;
  /** #197: sandbox logs and stats. Defaults to NoSandboxTelemetry (dev mode). */
  telemetry?: SandboxTelemetry;
  /** #217: a fake ngrok API for Drive previews (with PREVIEW_DOMAIN in envOverrides). */
  ngrok?: NgrokApi;
  /** #252: a VoiceService with a fake fetch. Defaults to one built from config (DEEPGRAM_API_KEY). */
  voice?: VoiceService;
  /** #257: a VoiceUsage with a fake fetch. */
  voiceUsage?: VoiceUsage;
  /** GitHub catalog. Defaults to one that reads `secretAdmin` (empty in tests → not configured). */
  githubCatalog?: GithubCatalog;
  /** E9: Agent Engine clients, e.g. createAgentEngine(fake.config(), { fetch: fake.fetch }). */
  agentEngine?: AgentEngine;
  /** E9 PR6: the A2A handler (the TCK build's scripted one, test/tck/sut.ts). */
  a2aHandler?: A2AHandlerFactory;
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
  // One wrapper, shared with the app. Route tests mutate `app.secretAdmin` and expect the next
  // GET to see it; wrapping again inside buildApp would split that cache from this object.
  const secretAdmin = new AppSecretCache(opts.secretAdmin ?? new MemorySecretAdmin());
  const providers = new SandboxProviders(config.sandboxProvider, {
    [config.sandboxProvider]: async () => provider,
    ...opts.extraProviders,
  });
  const app = await buildApp({
    store,
    config,
    provider: providers,
    secretsBroker,
    secretAdmin,
    github: opts.github,
    githubRefresh: opts.githubRefresh,
    telemetry: opts.telemetry,
    ngrok: opts.ngrok,
    voice: opts.voice,
    voiceUsage: opts.voiceUsage,
    githubCatalog: opts.githubCatalog,
    agentEngine: opts.agentEngine,
    a2aHandler: opts.a2aHandler,
  });
  await app.fastify.ready();
  return { ...app, store, provider, secretAdmin };
}

/**
 * E9.9: the link role (Dongles only, no dev identity) with Agent Engine on a fake (`parts`, memory
 * by default) and one Dongle per `[email, token]`. Share `store` and `agentEngine` with more
 * buildTestApp calls to see the web role's side.
 */
export async function laptopApp(opts: { tokens: ReadonlyArray<readonly [email: string, token: string]>; parts?: Array<"memory" | "agents"> }): Promise<{
  app: TestApp;
  fake: FakeAgentEngine;
  store: MemoryStore;
  agentEngine: AgentEngine;
}> {
  const fake = new FakeAgentEngine();
  const agentEngine = createAgentEngine(fake.config(opts.parts ?? ["memory"]), { fetch: fake.fetch });
  const store = new MemoryStore();
  for (const [i, [email, token]] of opts.tokens.entries()) {
    await store.tokens.insert({ id: `tok-${i}`, ownerEmail: email, name: "laptop", prefix: token.slice(0, 8), hash: hashToken(token), createdAt: new Date().toISOString() });
  }
  const app = await buildTestApp({ OUTFITTER_ROLE: "link", OUTFITTER_DEV: "0" }, { store, agentEngine });
  return { app, fake, store, agentEngine };
}

/** POST /api/admin/ops with a Dongle: `{op, args, ...extra}`, which must answer 200. */
export async function adminOp<T = { ok: boolean; text?: string; error?: string; needsApproval?: boolean; approvalId?: string; state?: string }>(
  app: TestApp,
  token: string,
  op: string,
  args: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<T> {
  const res = await app.fastify.inject({ method: "POST", url: "/api/admin/ops", headers: { authorization: `Bearer ${token}` }, payload: { op, args, ...extra } });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as T;
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
