// CloudRunProvider's adapter for the shared SandboxProvider contract suite
// (@outfitter/provider-local/testing, docs/specs/gke-sandbox-provider.md §6.2). The stub Jobs/
// Executions clients here follow the same in-memory-map style as cloudrun.test.ts's own stubs --
// no GCP credentials, no network.

import { CloudRunProvider } from "../src/providers/cloudrun.ts";
import { runProviderContract } from "@outfitter/provider-local/testing";
import type { ContractInstance, ContractWorld } from "@outfitter/provider-local/testing";
import type { SandboxHandle } from "@outfitter/provider-local";

interface FakeExecution {
  name: string;
  completionTime?: string;
  runningCount?: number;
  env: Record<string, string>;
}

function makeCloudRunContract(): ContractInstance {
  const executions = new Map<string, FakeExecution>();
  let counter = 0;
  const project = "p";
  const region = "r";
  const job = "outfitter-agent";

  const provider = new CloudRunProvider(
    { project, region, job },
    {
      jobsClient: async () => ({
        runJob: async (request: unknown) => {
          counter += 1;
          const name = `projects/${project}/locations/${region}/jobs/${job}/executions/exec-${counter}`;
          const req = request as { overrides: { containerOverrides: Array<{ env: Array<{ name: string; value: string }> }> } };
          const env = Object.fromEntries(req.overrides.containerOverrides[0].env.map((e) => [e.name, e.value]));
          const exec: FakeExecution = { name, runningCount: 1, env };
          executions.set(name, exec);
          return [
            {
              name: `projects/${project}/locations/${region}/jobs/${job}/operations/op-${counter}`,
              metadata: { name },
              getOperation: async () => {},
            },
            undefined,
            undefined,
          ] as const;
        },
      }),
      executionsClient: async () => ({
        getExecution: async (request: { name: string }) => {
          const exec = executions.get(request.name);
          if (!exec) throw Object.assign(new Error("execution not found"), { code: 5 });
          return [{ startTime: "2026-01-01T00:00:00Z", completionTime: exec.completionTime, runningCount: exec.runningCount }] as const;
        },
        cancelExecution: async (request: { name: string }) => {
          const exec = executions.get(request.name);
          if (exec) exec.completionTime = new Date().toISOString();
        },
        listExecutions: async () => [Array.from(executions.values())] as const,
      }),
    },
  );

  const world: ContractWorld = {
    async received(handle: SandboxHandle) {
      const exec = executions.get(handle);
      if (!exec) return undefined;
      return { runId: exec.env.RUN_ID, runToken: exec.env.RUN_TOKEN, apiOrigin: exec.env.OUTFITTER_API };
    },
    async exitByItself(handle: SandboxHandle) {
      const exec = executions.get(handle);
      if (exec) exec.completionTime = new Date().toISOString();
    },
  };

  return { provider, world };
}

runProviderContract("cloudrun", makeCloudRunContract);
