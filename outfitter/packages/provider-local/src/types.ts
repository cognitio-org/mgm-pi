/** Env agentd needs to start a run (see packages/agentd/src/main.ts's `requireEnv` calls and
 * outfitter/docs/protocol.md). The api package launches runs through a `SandboxProvider`; this is
 * the launch request shape every provider implementation accepts. */
export interface RunLaunch {
  runId: string;
  /** OUTFITTER_API: the api origin agentd dials for its WebSocket link. */
  apiOrigin: string;
  /** OUTFITTER_DEV_TOKEN: local-dev auth bypass; omitted in real deployments (GCE metadata token
   * is used instead). */
  devToken?: string;
  /** Docker image reference, LocalDockerProvider only. Defaults to "outfitter-agent". */
  image?: string;
  /** Extra env vars merged on top of the fixed OUTFITTER_API/RUN_ID/OUTFITTER_DEV_TOKEN set. */
  env?: Record<string, string>;
}

/** Provider-specific opaque handle: a container id for LocalDockerProvider, a pid for
 * InProcessProvider. Callers should not parse it. */
export type SandboxHandle = string;

export type SandboxStatus = "starting" | "running" | "exited" | "unknown";

export interface SandboxProvider {
  start(run: RunLaunch): Promise<{ handle: SandboxHandle }>;
  stop(handle: SandboxHandle): Promise<void>;
  status(handle: SandboxHandle): Promise<SandboxStatus>;
}
