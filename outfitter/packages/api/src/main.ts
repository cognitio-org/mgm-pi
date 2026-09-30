import { assertGkeConfigured, assertSandboxOrigin, loadConfig, mailboxWarning } from "./config.ts";
import { ensureSysopTape } from "./gurus-service.ts";
import { openStore } from "./store/index.ts";
import { createProviders } from "./providers/index.ts";
import {
  MemorySecretsBroker,
  GcpSecretsBroker,
  MemorySecretAdmin,
  GcpSecretAdmin,
  AppSecretCache,
  type SecretsBroker,
  type SecretAdmin,
} from "./secrets.ts";
import { buildApp } from "./server.ts";

const config = loadConfig();
assertSandboxOrigin(config);
assertGkeConfigured(config);
const mailboxProblem = mailboxWarning(config);
if (mailboxProblem) console.warn(JSON.stringify({ severity: "WARNING", message: mailboxProblem }));
const store = await openStore(config.mongodbUri, config.mongodbDb);
// The full registry, not just the default provider (createProvider's old return): after a later
// SANDBOX_PROVIDER switch, in-flight runs recorded under the *previous* default still need their
// provider reachable for stop/reconcile (gke-sandbox-provider.md §2.4/§2.6). createProviders
// registers cloudrun/gke factories whenever their own config (GCP_PROJECT + CLOUDRUN_JOB/
// GKE_CLUSTER) is present, not only when they're the current default.
const providers = createProviders(config);
const secretsBroker: SecretsBroker = config.devMode
  ? new MemorySecretsBroker()
  : new GcpSecretsBroker(config.gcpProject);
const secretAdmin: SecretAdmin = new AppSecretCache(
  config.devMode ? new MemorySecretAdmin() : new GcpSecretAdmin(config.gcpProject),
);

const app = await buildApp({ store, config, provider: providers, secretsBroker, secretAdmin });
// Sysop tools (#290): the built-in admin tape, once, on the web role. Never overwrites an edited one.
if (config.role !== "link") {
  await ensureSysopTape(store, config.defaultCloudModel).catch((err) => app.fastify.log.warn({ err }, "sysop tape seed failed"));
}

const port = Number.parseInt(process.env.PORT ?? "8080", 10);
await app.fastify.listen({ port, host: "0.0.0.0" });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    app.stopBackgroundTasks();
    await app.fastify.close();
    await store.close();
    process.exit(0);
  });
}
