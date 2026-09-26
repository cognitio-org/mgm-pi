// memoizeRetrying (providers/memo.ts, #169 review): one build shared by every caller, but a failed
// build is forgotten so the next call retries instead of failing for the rest of the process.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { memoizeRetrying } from "../src/providers/memo.ts";
import { CloudRunProvider } from "../src/providers/cloudrun.ts";

describe("memoizeRetrying", () => {
  test("builds once; concurrent and later callers share the result", async () => {
    let builds = 0;
    const get = memoizeRetrying(async () => ({ n: ++builds }));
    const [a, b] = await Promise.all([get(), get()]);
    assert.equal(a, b);
    assert.equal(await get(), a);
    assert.equal(builds, 1);
  });

  test("a rejected build is retried on the next call, then memoized once it succeeds", async () => {
    let builds = 0;
    const get = memoizeRetrying(async () => {
      builds++;
      if (builds === 1) throw new Error("transient");
      return "ok";
    });
    await assert.rejects(get, /transient/);
    assert.equal(await get(), "ok");
    assert.equal(await get(), "ok");
    assert.equal(builds, 2);
  });

  test("a factory that throws synchronously is a rejection, not a throw out of the getter", async () => {
    const get = memoizeRetrying((): Promise<string> => {
      throw new Error("sync boom");
    });
    const result = get();
    assert.ok(result instanceof Promise);
    await assert.rejects(result, /sync boom/);
  });
});

describe("CloudRunProvider's default clients", () => {
  test("the real ExecutionsClient is built once per provider, not once per call", async () => {
    const provider = new CloudRunProvider({ project: "p", region: "r", job: "j" });
    const deps = (provider as unknown as { deps: { executionsClient: () => Promise<{ close?: () => Promise<void> }> } }).deps;
    const first = await deps.executionsClient();
    const second = await deps.executionsClient();
    assert.equal(first, second);
    await first.close?.();
  });
});
