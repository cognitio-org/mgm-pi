import { assertSandboxOrigin, loadConfig } from "./config.ts";
import { openStore } from "./store/index.ts";
import { createProvider } from "./providers/index.ts";
import {
  MemorySecretsBroker,
  GcpSecretsBroker,
  MemorySecretAdmin,
  GcpSecretAdmin,
  type SecretsBroker,
  type SecretAdmin,
} from "./secrets.ts";
import { buildApp } from "./server.ts";

const config = loadConfig();
assertSandboxOrigin(config);
const store = await openStore(config.mongodbUri, config.mongodbDb);
const provider = await createProvider(config);
const secretsBroker: SecretsBroker = config.devMode
  ? new MemorySecretsBroker()
  : new GcpSecretsBroker(config.gcpProject);
const secretAdmin: SecretAdmin = config.devMode
  ? new MemorySecretAdmin()
  : new GcpSecretAdmin(config.gcpProject);

const app = await buildApp({ store, config, provider, secretsBroker, secretAdmin });

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
