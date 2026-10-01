import type { PreviewService } from "../previews.ts";
import type { TurnWaiters } from "../turns.ts";
import type { AeSessions } from "../ae-sessions.ts";
import type { Store } from "../store/types.ts";
import type { SessionIndexer } from "../search/service.ts";
import type { Config } from "../config.ts";
import type { RunManager } from "../runs.ts";
import type { AgentLink } from "../agentlink.ts";
import type { SseHub, SsePoller } from "../sse.ts";
import type { LaptopProbe } from "../laptop.ts";
import type { ProviderStatusService } from "../providers-status.ts";
import type { ModelsService } from "../models.ts";
import type { SecretAdmin } from "../secrets.ts";
import type { MailService } from "../mail.ts";
import type { SandboxProviders } from "../providers/registry.ts";
import type { SandboxTelemetry } from "../sandbox-telemetry.ts";
import type { VoiceService } from "../voice.ts";
import type { VoiceUsage } from "../voice-usage.ts";
import type { GithubCatalog } from "../github-catalog.ts";

/** Dependencies every route module needs; built once in server.ts and threaded through. */
export interface RouteContext {
  store: Store;
  /** Session search (#289): keeps sessionChunks in step with imports and formats. */
  indexer: SessionIndexer;
  config: Config;
  runs: RunManager;
  agentLink: AgentLink;
  sse: SseHub;
  /** The full SandboxProvider registry (gke-sandbox-provider.md §2.4) -- only routes/hooks.ts's
   * POST /api/hooks/warm-pool needs this directly (to reach the gke provider specifically, not
   * just whichever provider is the deployment's current default). */
  providers: SandboxProviders;
  /** Bug 2 (docs/reports/cloud-fixes.md): keeps GET /api/sessions/:id/stream live in a split
   * web/link deployment by polling the shared store instead of relying only on AgentLink's
   * in-process publish (see sse.ts's SsePoller doc comment). */
  ssePoller: SsePoller;
  laptopProbe: LaptopProbe;
  providerStatus: ProviderStatusService;
  modelsService: ModelsService;
  /** Operator settings routes only (routes/operator.ts): Secret Manager access behind an
   * interface, so tests run against MemorySecretAdmin with no GCP. */
  secretAdmin: SecretAdmin;
  mail: MailService;
  /** #217 Drive previews: the tick sweeps expired and orphaned preview endpoints. */
  previews: PreviewService;
  /** E9 §1 turn waiters: the tick sweeps their deadlines and runs that ended without a bye. */
  turns: TurnWaiters;
  /** E9 §4: the tick, archive and format stop the Agent Engine sessions a closed session opened. */
  aeSessions: AeSessions;
  /** #197: sandbox logs (Cloud Logging, through the scoped log view) and stats (Cloud Monitoring).
   * NoSandboxTelemetry in dev and tests unless one injects a fake. */
  telemetry: SandboxTelemetry;
  /** #252 web voice: mints short-lived Deepgram tokens (routes/voice.ts). */
  voice: VoiceService;
  /** #257: per-person Deepgram spend, read back from Deepgram's usage API. */
  voiceUsage: VoiceUsage;
  /** Repositories the GitHub App can reach, plus creating one and a Floppy's live status.
   * Mints its own tokens; a Drive's installation token is unchanged. */
  githubCatalog: GithubCatalog;
}
