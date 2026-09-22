import type { Store } from "../store/types.ts";
import type { Config } from "../config.ts";
import type { RunManager } from "../runs.ts";
import type { AgentLink } from "../agentlink.ts";
import type { SseHub } from "../sse.ts";
import type { LaptopProbe } from "../laptop.ts";
import type { ProviderStatusService } from "../providers-status.ts";
import type { ModelsService } from "../models.ts";
import type { SecretAdmin } from "../secrets.ts";
import type { MailService } from "../mail.ts";

/** Dependencies every route module needs; built once in server.ts and threaded through. */
export interface RouteContext {
  store: Store;
  config: Config;
  runs: RunManager;
  agentLink: AgentLink;
  sse: SseHub;
  laptopProbe: LaptopProbe;
  providerStatus: ProviderStatusService;
  modelsService: ModelsService;
  /** Operator settings routes only (routes/operator.ts): Secret Manager access behind an
   * interface, so tests run against MemorySecretAdmin with no GCP. */
  secretAdmin: SecretAdmin;
  mail: MailService;
}
