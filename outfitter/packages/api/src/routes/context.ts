import type { Store } from "../store/types.ts";
import type { Config } from "../config.ts";
import type { RunManager } from "../runs.ts";
import type { AgentLink } from "../agentlink.ts";
import type { SseHub } from "../sse.ts";
import type { LaptopProbe } from "../laptop.ts";
import type { ProviderStatusService } from "../providers-status.ts";

/** Dependencies every route module needs; built once in server.ts and threaded through. */
export interface RouteContext {
  store: Store;
  config: Config;
  runs: RunManager;
  agentLink: AgentLink;
  sse: SseHub;
  laptopProbe: LaptopProbe;
  providerStatus: ProviderStatusService;
}
