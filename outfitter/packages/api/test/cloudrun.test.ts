// Bug: CloudRunProvider.start used to store `operation.name` (the runJob long-running operation's
// own name, e.g. ".../operations/<uuid>") as the run's SandboxHandle. status()/stop() call
// ExecutionsClient with that handle, which only understands *execution* names
// (".../executions/<name>") -- so both silently no-op against a real API (404s swallowed as
// "unknown" / a cancel that cancels nothing), and the reconciler's "stop the stale run's sandbox"
// never actually touched the running Cloud Run execution. These tests stub JobsClient/
// ExecutionsClient (no GCP credentials needed) to pin down the fix: the handle must be the
// execution name, taken from the runJob operation's decoded `metadata`, and status()/stop() must
// operate on it correctly.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CloudRunProvider } from "../src/providers/cloudrun.ts";

const EXECUTION_NAME = "projects/p/locations/r/jobs/outfitter-agent/executions/outfitter-agent-abcde";
const OPERATION_NAME = "projects/p/locations/r/jobs/outfitter-agent/operations/op-12345";

function baseConfig() {
  return { project: "p", region: "r", job: "outfitter-agent" };
}

describe("CloudRunProvider", () => {
  test("start() stores the execution name (from the runJob operation's metadata), not the operation name", async () => {
    const runJobCalls: unknown[] = [];
    const provider = new CloudRunProvider(baseConfig(), {
      jobsClient: async () => ({
        runJob: async (request: unknown) => {
          runJobCalls.push(request);
          return [
            {
              name: OPERATION_NAME,
              metadata: { name: EXECUTION_NAME },
              getOperation: async () => {
                throw new Error("getOperation should not be needed when metadata.name is already present");
              },
            },
            undefined,
            undefined,
          ];
        },
      }),
    });

    const { handle } = await provider.start({ runId: "run-1", apiOrigin: "https://api.example", runToken: "tok" });

    assert.equal(handle, EXECUTION_NAME);
    assert.notEqual(handle, OPERATION_NAME);
    assert.equal(runJobCalls.length, 1);
    const req = runJobCalls[0] as { overrides: { containerOverrides: Array<{ env: Array<{ name: string; value: string }> }> } };
    const env = Object.fromEntries(req.overrides.containerOverrides[0].env.map((e) => [e.name, e.value]));
    assert.equal(env.RUN_ID, "run-1");
    assert.equal(env.RUN_TOKEN, "tok");
  });

  test("start() falls back to a bounded poll via getOperation() when metadata.name isn't on the first response", async () => {
    let getOperationCalls = 0;
    const provider = new CloudRunProvider(baseConfig(), {
      executionNamePoll: { intervalMs: 0, maxAttempts: 5 },
      jobsClient: async () => ({
        runJob: async () => {
          const operation = {
            name: OPERATION_NAME,
            metadata: null as { name?: string } | null,
            getOperation: async () => {
              getOperationCalls++;
              if (getOperationCalls >= 2) operation.metadata = { name: EXECUTION_NAME };
            },
          };
          return [operation, undefined, undefined];
        },
      }),
    });

    const { handle } = await provider.start({ runId: "run-1", apiOrigin: "https://api.example", runToken: "tok" });

    assert.equal(handle, EXECUTION_NAME);
    assert.equal(getOperationCalls, 2);
  });

  test("start() throws rather than store a handle when the execution name never appears", async () => {
    const provider = new CloudRunProvider(baseConfig(), {
      executionNamePoll: { intervalMs: 0, maxAttempts: 3 },
      jobsClient: async () => ({
        runJob: async () => [
          { name: OPERATION_NAME, metadata: null, getOperation: async () => {} },
          undefined,
          undefined,
        ],
      }),
    });

    await assert.rejects(
      () => provider.start({ runId: "run-1", apiOrigin: "https://api.example", runToken: "tok" }),
      /execution name never appeared/,
    );
  });

  test("status() and stop() call ExecutionsClient with the stored execution-name handle", async () => {
    const getExecutionCalls: unknown[] = [];
    const cancelExecutionCalls: unknown[] = [];
    const provider = new CloudRunProvider(baseConfig(), {
      executionsClient: async () => ({
        getExecution: async (request: { name: string }) => {
          getExecutionCalls.push(request);
          return [{ startTime: "2026-01-01T00:00:00Z", completionTime: undefined, runningCount: 1 }];
        },
        cancelExecution: async (request: { name: string }) => {
          cancelExecutionCalls.push(request);
        },
      }),
    });

    const status = await provider.status(EXECUTION_NAME);
    assert.equal(status, "running");
    assert.deepEqual(getExecutionCalls, [{ name: EXECUTION_NAME }]);

    await provider.stop(EXECUTION_NAME);
    assert.deepEqual(cancelExecutionCalls, [{ name: EXECUTION_NAME }]);
  });

  test("status() reports starting/exited/unknown from Execution fields, per the v2 Execution doc", async () => {
    let nextExecution: { startTime?: string; completionTime?: string; runningCount?: number } = {};
    const provider = new CloudRunProvider(baseConfig(), {
      executionsClient: async () => ({
        getExecution: async () => [nextExecution],
        cancelExecution: async () => {},
      }),
    });

    nextExecution = {};
    assert.equal(await provider.status(EXECUTION_NAME), "starting"); // no startTime yet

    nextExecution = { startTime: "2026-01-01T00:00:00Z", runningCount: 0 };
    assert.equal(await provider.status(EXECUTION_NAME), "starting"); // started, not yet running

    nextExecution = { startTime: "2026-01-01T00:00:00Z", completionTime: "2026-01-01T00:05:00Z" };
    assert.equal(await provider.status(EXECUTION_NAME), "exited");

    assert.equal(await provider.status(""), "unknown"); // no handle at all
  });

  // gke-sandbox-provider.md §6.2 C6, plan §5 item 3: a stale handle whose execution has since been
  // garbage-collected must report "exited" or "unknown", and must not throw -- the contract itself
  // (and any other direct status() caller), not reconcileOnce (runs.ts), which treats "unknown"
  // and "exited" identically anyway (both fall through to stop()-then-mark-failed; only "starting"
  // is special-cased there).
  test("status() maps a NOT_FOUND (grpc code 5) getExecution error to 'exited' instead of throwing", async () => {
    const provider = new CloudRunProvider(baseConfig(), {
      executionsClient: async () => ({
        getExecution: async () => {
          throw Object.assign(new Error("execution not found"), { code: 5 });
        },
        cancelExecution: async () => {},
      }),
    });

    assert.equal(await provider.status(EXECUTION_NAME), "exited");
  });

  test("status() maps a Gaxios-style HTTP 404 (response.status, no grpc code) to 'exited' too", async () => {
    const provider = new CloudRunProvider(baseConfig(), {
      executionsClient: async () => ({
        getExecution: async () => {
          throw Object.assign(new Error("Not Found"), { response: { status: 404 } });
        },
        cancelExecution: async () => {},
      }),
    });

    assert.equal(await provider.status(EXECUTION_NAME), "exited");
  });

  test("status() rethrows a non-NOT_FOUND getExecution error (permission denied)", async () => {
    const provider = new CloudRunProvider(baseConfig(), {
      executionsClient: async () => ({
        getExecution: async () => {
          throw Object.assign(new Error("permission denied"), { code: 7 });
        },
        cancelExecution: async () => {},
      }),
    });

    await assert.rejects(() => provider.status(EXECUTION_NAME), /permission denied/);
  });

  test("status() rethrows a network error (ECONNREFUSED) rather than treating it as not-found", async () => {
    const provider = new CloudRunProvider(baseConfig(), {
      executionsClient: async () => ({
        getExecution: async () => {
          throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        },
        cancelExecution: async () => {},
      }),
    });

    await assert.rejects(() => provider.status(EXECUTION_NAME), /ECONNREFUSED/);
  });

  // gke-sandbox-provider.md §6.2 C4, plan §5 item 5: stop() must be idempotent, including on an
  // execution that has already reached a terminal phase on its own -- Cloud Run most likely
  // answers that cancelExecution call with FAILED_PRECONDITION, and a since-garbage-collected
  // execution with NOT_FOUND. Both mean "already stopped", not a real failure.
  test("stop() swallows NOT_FOUND (grpc code 5) from cancelExecution: already gone, not an error", async () => {
    const cancelCalls: unknown[] = [];
    const provider = new CloudRunProvider(baseConfig(), {
      executionsClient: async () => ({
        getExecution: async () => [{}],
        cancelExecution: async (request: { name: string }) => {
          cancelCalls.push(request);
          throw Object.assign(new Error("execution not found"), { code: 5 });
        },
      }),
    });

    await assert.doesNotReject(() => provider.stop(EXECUTION_NAME));
    assert.equal(cancelCalls.length, 1);
  });

  test("stop() swallows FAILED_PRECONDITION (grpc code 9) from cancelExecution: already finished, not an error", async () => {
    const provider = new CloudRunProvider(baseConfig(), {
      executionsClient: async () => ({
        getExecution: async () => [{}],
        cancelExecution: async () => {
          throw Object.assign(new Error("execution already finished"), { code: 9 });
        },
      }),
    });

    await assert.doesNotReject(() => provider.stop(EXECUTION_NAME));
  });

  test("stop() rethrows a cancelExecution error that is neither NOT_FOUND nor FAILED_PRECONDITION", async () => {
    const provider = new CloudRunProvider(baseConfig(), {
      executionsClient: async () => ({
        getExecution: async () => [{}],
        cancelExecution: async () => {
          throw Object.assign(new Error("permission denied"), { code: 7 });
        },
      }),
    });

    await assert.rejects(() => provider.stop(EXECUTION_NAME), /permission denied/);
  });

  test("capacity() counts non-completed executions via countRunningExecutions", async () => {
    const provider = new CloudRunProvider(baseConfig(), {
      executionsClient: async () => ({
        getExecution: async () => [{}],
        cancelExecution: async () => {},
        listExecutions: async () => [[{ completionTime: undefined }, { completionTime: "2026-01-01T00:00:00Z" }, {}]],
      }),
    });

    assert.deepEqual(await provider.capacity(), { active: 2 });
  });
});
