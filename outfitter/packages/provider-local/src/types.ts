/** Env agentd needs to start a run (see packages/agentd/src/main.ts's `requireEnv` calls and
 * outfitter/docs/protocol.md). The api package launches runs through a `SandboxProvider`; this is
 * the launch request shape every provider implementation accepts. */
export interface RunLaunch {
  runId: string;
  /** OUTFITTER_API: the api origin agentd dials for its WebSocket link. */
  apiOrigin: string;
  /** RUN_TOKEN: the per-run secret RunManager.wake (packages/api/src/runs.ts) generates and hashes
   * onto the Run record. agentd sends it back in the `hello` frame so AgentLink can prove the
   * connecting process is *this* run's own execution, not merely something holding a valid agent
   * SA id token for *some* run (docs/reports/security-review-pr1.md finding #2). */
  runToken: string;
  /** OUTFITTER_DEV_TOKEN: local-dev auth bypass; omitted in real deployments (GCE metadata token
   * is used instead). */
  devToken?: string;
  /** Docker image reference, LocalDockerProvider only. Defaults to "outfitter-agent". */
  image?: string;
  /** Extra env vars merged on top of the fixed OUTFITTER_API/RUN_ID/RUN_TOKEN/OUTFITTER_DEV_TOKEN set. */
  env?: Record<string, string>;
}

/** Provider-specific opaque handle: a container id for LocalDockerProvider, a pid for
 * InProcessProvider. Callers should not parse it. */
export type SandboxHandle = string;

export type SandboxStatus = "starting" | "running" | "exited" | "unknown";

/** Sandbox capacity for the Peripherals/providers dashboard (gke-sandbox-provider.md §2.3, gap G3:
 * capacity used to be `instanceof CloudRunProvider`, which breaks once a second cloud provider
 * exists). Optional on SandboxProvider -- only providers with something to count implement it. */
export interface SandboxCapacity {
  /** Sandboxes currently starting or running, started by this deployment. */
  active: number;
  /** Warm, unclaimed sandboxes ready right now (GKE only). */
  warmReady?: number;
  /** Warm pool's desired size (GKE only; 0 outside active hours). */
  warmDesired?: number;
  /** Hard cap on concurrently active sandboxes, when the provider enforces one. */
  limit?: number;
  /** How new runs claim a sandbox (GKE only): "warm" adopts a pool pod when one is ready, "cold"
   * always starts a fresh one. With warmDesired it says whether new runs actually start warm. */
  launchMode?: "warm" | "cold";
}

/** start()'s return type (gap G4: warm vs. cold start telemetry). A structural superset of the
 * old `{ handle }` shape, so every existing provider's `start()` return type annotation stays
 * exactly as it was and still satisfies this interface. */
export interface SandboxStartResult {
  handle: SandboxHandle;
  /** true = adopted a warm sandbox, false = cold start, undefined = provider can't tell. */
  warm?: boolean;
}

/** How a sandbox's agent container ended (#193), as the orchestrator recorded it. */
export interface SandboxExit {
  /** The orchestrator's own word: Kubernetes' `OOMKilled`, `Error`, `Completed`, ... */
  reason: string;
  exitCode?: number;
  /** ISO time the container finished, when known. */
  finishedAt?: string;
}

/** A live sandbox's details for the session page (#197). Every field is optional: providers fill
 * what they know. Never includes the pod's annotations or env (a warm run's token lives there). */
export interface SandboxInfo {
  /** The pod (GKE) or execution (Cloud Run) name. */
  name?: string;
  node?: string;
  /** The agent container's image. */
  image?: string;
  /** Pending, Running, Succeeded, Failed. */
  phase?: string;
  startedAt?: string;
  resources?: { cpu?: string; memory?: string; ephemeralStorage?: string };
  exit?: SandboxExit;
}

export interface SandboxProvider {
  start(run: RunLaunch): Promise<SandboxStartResult>;
  stop(handle: SandboxHandle): Promise<void>;
  status(handle: SandboxHandle): Promise<SandboxStatus>;
  /** Optional: capacity for the Peripherals dashboard (gke-sandbox-provider.md §2.3/§2.4). */
  capacity?(): Promise<SandboxCapacity>;
  /** Optional (#193): how the sandbox's agent container ended. Undefined while it's still running,
   * once the sandbox is gone, or when the provider can't tell. Never throws for "not found". */
  exitInfo?(handle: SandboxHandle): Promise<SandboxExit | undefined>;
  /** Optional (#197): the live sandbox's details. Undefined once it's gone or when the provider
   * can't tell. Never throws for "not found". */
  describe?(handle: SandboxHandle): Promise<SandboxInfo | undefined>;
}
