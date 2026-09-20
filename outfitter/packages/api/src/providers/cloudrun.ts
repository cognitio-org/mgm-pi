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

export class CloudRunProvider implements SandboxProvider {
  private readonly config: CloudRunProviderConfig;

  constructor(config: CloudRunProviderConfig) {
    this.config = config;
  }

  private async jobsClient() {
    const { JobsClient } = await import("@google-cloud/run");
    return new JobsClient();
  }

  private async executionsClient() {
    const { ExecutionsClient } = await import("@google-cloud/run");
    return new ExecutionsClient();
  }

  async start(run: RunLaunch): Promise<{ handle: SandboxHandle }> {
    const client = await this.jobsClient();
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
    return { handle: operation.name ?? "" };
  }

  async stop(handle: SandboxHandle): Promise<void> {
    if (!handle) return;
    const client = await this.executionsClient();
    await client.cancelExecution({ name: handle });
  }

  async status(handle: SandboxHandle): Promise<SandboxStatus> {
    if (!handle) return "unknown";
    const client = await this.executionsClient();
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
}
