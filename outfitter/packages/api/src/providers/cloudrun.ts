// Production provider: one Cloud Run Job execution per run. `@google-cloud/run` is imported lazily
// inside client() so importing this module (or the package as a whole) never requires GCP
// credentials or the grpc dependency chain at test time.

import type { SandboxProvider, RunStartInput, ProviderStatus } from "./types.ts";

export interface CloudRunProviderConfig {
  project: string;
  region: string;
  job: string;
  apiOrigin: string;
}

interface CloudRunHandle {
  executionName?: string;
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

  async start(run: RunStartInput): Promise<{ handle: unknown }> {
    const client = await this.jobsClient();
    const name = `projects/${this.config.project}/locations/${this.config.region}/jobs/${this.config.job}`;
    const [operation] = await client.runJob({
      name,
      overrides: {
        containerOverrides: [
          {
            env: [
              { name: "RUN_ID", value: run.runId },
              { name: "OUTFITTER_API", value: this.config.apiOrigin },
            ],
          },
        ],
      },
    });
    const handle: CloudRunHandle = { executionName: operation.name ?? undefined };
    return { handle };
  }

  async stop(handle: unknown): Promise<void> {
    const executionName = (handle as CloudRunHandle).executionName;
    if (!executionName) return;
    const client = await this.executionsClient();
    await client.cancelExecution({ name: executionName });
  }

  async status(handle: unknown): Promise<ProviderStatus> {
    const executionName = (handle as CloudRunHandle).executionName;
    if (!executionName) return { state: "unknown" };
    const client = await this.executionsClient();
    const [execution] = await client.getExecution({ name: executionName });
    if (!execution.completionTime) return { state: "running" };
    return { state: "stopped", detail: execution.failedCount ? "failed tasks" : undefined };
  }
}
