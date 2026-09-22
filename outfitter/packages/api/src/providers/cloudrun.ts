// Production provider: one Cloud Run Job execution per run. `@google-cloud/run` is imported lazily
// inside client() so importing this module (or the package as a whole) never requires GCP
// credentials or the grpc dependency chain at test time.

import type { SandboxProvider, RunLaunch, SandboxStatus, SandboxHandle } from "@outfitter/provider-local";

export interface CloudRunProviderConfig {
  project: string;
  region: string;
  job: string;
  apiOrigin: string;
}

/** google.cloud.run.v2.Execution fields this provider actually reads (see status() below for the
 * full field doc). Loosely typed rather than importing @google-cloud/run's generated protos here,
 * since this shape also has to match the stubs cloudrun.test.ts hands in. */
interface ExecutionLike {
  name?: string | null;
  startTime?: unknown;
  completionTime?: unknown;
  runningCount?: number | null;
}

/** The gax `Operation` returned (wrapped in a tuple) by JobsClient#runJob. `metadata` is the
 * decoded google.cloud.run.v2.Execution the *moment* the job run is accepted -- Cloud Run sets it
 * (including `name`, the execution resource name) synchronously in the LRO's first response,
 * before the execution has actually finished; `getOperation()` re-polls and refreshes `metadata`
 * in place. */
interface RunJobOperation {
  name?: string | null;
  metadata?: ExecutionLike | null;
  getOperation(): Promise<unknown>;
}

interface JobsClientLike {
  runJob(request: unknown): Promise<[RunJobOperation, unknown, unknown]>;
}

interface ExecutionsClientLike {
  cancelExecution(request: { name: string }): Promise<unknown>;
  getExecution(request: { name: string }): Promise<[ExecutionLike]>;
  /** Used by countRunningExecutions (E2.10 provider status: Cloud Run job capacity probe). Optional
   * so existing status()/stop()-only test stubs don't need to grow a method they never call. */
  listExecutions?(request: { parent: string }): Promise<[ExecutionLike[]]>;
}

/** Test-injectable client factories; production code lets these default to the lazy real ones. */
export interface CloudRunProviderDeps {
  jobsClient?: () => Promise<JobsClientLike>;
  executionsClient?: () => Promise<ExecutionsClientLike>;
  /** Bounded fallback poll for the rare case runJob's first response doesn't carry
   * metadata.name yet -- overridable so tests don't sleep for real. */
  executionNamePoll?: { intervalMs: number; maxAttempts: number };
}

const DEFAULT_EXECUTION_NAME_POLL = { intervalMs: 1000, maxAttempts: 10 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CloudRunProvider implements SandboxProvider {
  private readonly config: CloudRunProviderConfig;
  private readonly deps: Required<CloudRunProviderDeps>;

  constructor(config: CloudRunProviderConfig, deps: CloudRunProviderDeps = {}) {
    this.config = config;
    this.deps = {
      jobsClient: deps.jobsClient ?? (() => this.defaultJobsClient()),
      executionsClient: deps.executionsClient ?? (() => this.defaultExecutionsClient()),
      executionNamePoll: deps.executionNamePoll ?? DEFAULT_EXECUTION_NAME_POLL,
    };
  }

  private async defaultJobsClient(): Promise<JobsClientLike> {
    const { JobsClient } = await import("@google-cloud/run");
    return new JobsClient() as unknown as JobsClientLike;
  }

  private async defaultExecutionsClient(): Promise<ExecutionsClientLike> {
    const { ExecutionsClient } = await import("@google-cloud/run");
    return new ExecutionsClient() as unknown as ExecutionsClientLike;
  }

  async start(run: RunLaunch): Promise<{ handle: SandboxHandle }> {
    const client = await this.deps.jobsClient();
    const name = `projects/${this.config.project}/locations/${this.config.region}/jobs/${this.config.job}`;
    const [operation] = await client.runJob({
      name,
      overrides: {
        containerOverrides: [
          {
            env: [
              { name: "RUN_ID", value: run.runId },
              { name: "RUN_TOKEN", value: run.runToken },
              { name: "OUTFITTER_API", value: run.apiOrigin },
            ],
          },
        ],
      },
    });
    // provider-local's SandboxHandle is a plain string (an executionName here, a container id for
    // LocalDockerProvider, a synthetic id for InProcessProvider) -- callers should not parse it.
    //
    // Bug fix: `operation.name` is the *long-running operation's* name (something like
    // ".../operations/<uuid>"), not the execution's -- status()/stop() call ExecutionsClient with
    // whatever handle is stored here, so a wrong handle makes both silently no-op (getExecution
    // 404s -> "unknown", cancelExecution 404s and does nothing), which is exactly how a stale run
    // survived the reconciler's cancel until someone killed it by hand. The execution's own
    // resource name lives in the LRO's decoded `metadata` instead.
    const executionName = await this.resolveExecutionName(operation);
    return { handle: executionName };
  }

  /** Cloud Run populates the LRO's `metadata` (decoded as an Execution, `name` included) as soon
   * as the job run is accepted -- normally available synchronously off the very first `runJob`
   * response, well before the execution finishes. Falls back to a short bounded poll via
   * `getOperation()` (which refreshes `metadata` in place) for the rare case it isn't there yet;
   * throws rather than storing an operation name if it never shows up. */
  private async resolveExecutionName(operation: RunJobOperation): Promise<string> {
    const fromMetadata = operation.metadata?.name;
    if (fromMetadata) return fromMetadata;

    const { intervalMs, maxAttempts } = this.deps.executionNamePoll;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(intervalMs);
      await operation.getOperation();
      const name = operation.metadata?.name;
      if (name) return name;
    }
    throw new Error(
      `cloud run: execution name never appeared on runJob operation ${operation.name ?? "<unknown>"} ` +
        `after ${maxAttempts} poll attempts`,
    );
  }

  async stop(handle: SandboxHandle): Promise<void> {
    if (!handle) return;
    const client = await this.deps.executionsClient();
    await client.cancelExecution({ name: handle });
  }

  async status(handle: SandboxHandle): Promise<SandboxStatus> {
    if (!handle) return "unknown";
    const client = await this.deps.executionsClient();
    const [execution] = await client.getExecution({ name: handle });
    // Cloud Run v2 Execution resource fields
    // (https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs.executions#Execution):
    // startTime is unset until the first task actually starts running, so an execution still
    // waiting on a cold start (image pull, scheduling) reports no startTime yet -> "starting".
    // completionTime is set once every task has reached a terminal phase (succeeded/failed/
    // cancelled) -> "exited". In between, runningCount > 0 means at least one task is actively
    // executing -> "running"; runningCount === 0 with a startTime but no completionTime yet
    // (e.g. between retries, or briefly at task startup) is still "starting".
    if (!execution.startTime) return "starting";
    if (execution.completionTime) return "exited";
    if ((execution.runningCount ?? 0) > 0) return "running";
    return "starting";
  }

  /** E2.10 provider status: how many executions of this Job are currently active (no
   * completionTime yet -- still starting or running), regardless of which run started them. Used
   * to show sandbox capacity on the providers dashboard (E3.6), not by any per-run status() path. */
  async countRunningExecutions(): Promise<number> {
    const client = await this.deps.executionsClient();
    if (!client.listExecutions) throw new Error("cloud run: executions client has no listExecutions");
    const parent = `projects/${this.config.project}/locations/${this.config.region}/jobs/${this.config.job}`;
    const [executions] = await client.listExecutions({ parent });
    return executions.filter((e) => !e.completionTime).length;
  }
}
