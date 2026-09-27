// #197: sandbox logs (Cloud Logging, through the scoped view) and stats (Cloud Monitoring), against
// a fake HTTP client that records every request. No credentials, no network.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CachedSandboxTelemetry,
  GcpSandboxTelemetry,
  TelemetryUnavailable,
  type SandboxTelemetry,
  isPodName,
  isRunId,
  sandboxLogViewName,
  toLogPage,
  toSeries,
} from "../src/sandbox-telemetry.ts";

const RUN = "8d1f524d-1111-4222-8333-944455556666";

function fakeClient(answer: (opts: { url: string; data?: any; params?: Record<string, string> }) => unknown) {
  const calls: { url: string; method?: string; data?: any; params?: Record<string, string> }[] = [];
  return {
    calls,
    client: {
      async request<T>(opts: { url: string; method?: "GET" | "POST"; data?: unknown; params?: Record<string, string> }) {
        calls.push(opts as never);
        const data = answer(opts as never);
        if (data instanceof Error) throw data;
        return { data: data as T };
      },
    },
  };
}

describe("sandbox telemetry: input shapes", () => {
  test("a run id is a UUID and a pod name a DNS label, nothing that could break out of a filter", () => {
    assert.equal(isRunId(RUN), true);
    for (const bad of ['x" OR logName:*', "8d1f524d", `${RUN} `, ""]) assert.equal(isRunId(bad), false, bad);
    assert.equal(isPodName("outfitter-agent-jjqf6"), true);
    for (const bad of ['a" OR "b', "UPPER", "-lead", "a_b", "x".repeat(64)]) assert.equal(isPodName(bad), false, bad);
  });
});

describe("GcpSandboxTelemetry.logs", () => {
  test("reads only through the sandbox log view, filtered to the run id, newest first, and returns oldest first", async () => {
    const fake = fakeClient(() => ({
      entries: [
        { timestamp: "2026-09-26T05:01:12Z", severity: "INFO", jsonPayload: { message: "second" }, resource: { labels: { pod_name: "outfitter-agent-jjqf6" } } },
        { timestamp: "2026-09-26T05:01:10Z", severity: "DEBUG", textPayload: "first", resource: { labels: { pod_name: "outfitter-agent-jjqf6" } } },
      ],
      nextPageToken: "tok-1",
    }));
    const telemetry = new GcpSandboxTelemetry("proj", "outfitter-sandboxes", fake.client);
    const page = await telemetry.logs(RUN, { pageSize: 50 });

    assert.equal(fake.calls.length, 1);
    const call = fake.calls[0]!;
    assert.equal(call.url, "https://logging.googleapis.com/v2/entries:list");
    assert.deepEqual(call.data.resourceNames, [sandboxLogViewName("proj")]);
    assert.equal(call.data.resourceNames[0], "projects/proj/locations/global/buckets/outfitter-sandboxes/views/_AllLogs");
    assert.equal(call.data.filter, `jsonPayload.runId="${RUN}"`);
    assert.equal(call.data.orderBy, "timestamp desc");
    assert.equal(call.data.pageSize, 50);
    assert.deepEqual(page.lines.map((l) => l.message), ["first", "second"]);
    assert.equal(page.nextPageToken, "tok-1");
    assert.equal(page.podName, "outfitter-agent-jjqf6");
  });

  test("refuses a bad run id or page token before any request", async () => {
    const fake = fakeClient(() => ({}));
    const telemetry = new GcpSandboxTelemetry("proj", "outfitter-sandboxes", fake.client);
    for (const call of [telemetry.logs('x" OR true'), telemetry.logs(RUN, { pageToken: 'a"b c' })]) {
      await assert.rejects(call, (err: unknown) => err instanceof TelemetryUnavailable && err.kind === "bad-request");
    }
    assert.equal(fake.calls.length, 0);
  });

  test("clamps the page size and truncates a very long line", async () => {
    const fake = fakeClient(() => ({ entries: [{ timestamp: "t", jsonPayload: { message: "y".repeat(10_000) } }] }));
    const page = await new GcpSandboxTelemetry("proj", "outfitter-sandboxes", fake.client).logs(RUN, { pageSize: 10_000 });
    assert.equal(fake.calls[0]!.data.pageSize, 200);
    assert.ok(page.lines[0]!.message.length < 4100);
    assert.match(page.lines[0]!.message, /\[truncated\]$/);
  });

  test("a 403 is 'forbidden' (grant missing); other failures are 'failed', with no Google body", async () => {
    const forbidden = fakeClient(() => Object.assign(new Error("PERMISSION_DENIED: views.access on projects/proj ..."), { response: { status: 403 } }));
    await assert.rejects(new GcpSandboxTelemetry("proj", "outfitter-sandboxes", forbidden.client).logs(RUN), (err: unknown) => {
      assert.ok(err instanceof TelemetryUnavailable);
      assert.equal(err.kind, "forbidden");
      assert.doesNotMatch(err.message, /PERMISSION_DENIED/);
      return true;
    });
    const broken = fakeClient(() => Object.assign(new Error("boom"), { response: { status: 500 } }));
    await assert.rejects(new GcpSandboxTelemetry("proj", "outfitter-sandboxes", broken.client).logs(RUN), (err: unknown) => {
      assert.ok(err instanceof TelemetryUnavailable);
      assert.equal(err.kind, "failed");
      return true;
    });
  });
});

describe("GcpSandboxTelemetry.metrics", () => {
  test("queries memory (non-evictable), CPU rate and disk for the one pod in the sandbox namespace", async () => {
    const fake = fakeClient((opts) => {
      const filter = opts.params?.filter ?? "";
      if (filter.includes("memory/used_bytes")) {
        return { timeSeries: [{ points: [{ interval: { endTime: "2026-09-26T05:03:00Z" }, value: { int64Value: String(1277 * 1024 * 1024) } }] }] };
      }
      if (filter.includes("cpu/core_usage_time")) {
        return { timeSeries: [{ points: [{ interval: { endTime: "2026-09-26T05:03:00Z" }, value: { doubleValue: 0.93 } }] }] };
      }
      return { timeSeries: [] };
    });
    const start = new Date("2026-09-26T04:55:00Z");
    const end = new Date("2026-09-26T05:06:00Z");
    const metrics = await new GcpSandboxTelemetry("proj", "outfitter-sandboxes", fake.client).metrics("outfitter-agent-jjqf6", start, end);

    assert.equal(fake.calls.length, 3);
    for (const call of fake.calls) {
      assert.equal(call.url, "https://monitoring.googleapis.com/v3/projects/proj/timeSeries");
      assert.match(call.params!.filter!, /resource.labels.namespace_name="outfitter-sandboxes" AND resource.labels.pod_name="outfitter-agent-jjqf6"/);
      assert.equal(call.params!["interval.startTime"], start.toISOString());
      assert.equal(call.params!["aggregation.alignmentPeriod"], "60s");
    }
    assert.match(fake.calls[0]!.params!.filter!, /memory_type="non-evictable"/);
    assert.deepEqual(metrics.memoryMb, [["2026-09-26T05:03:00Z", 1277]]);
    assert.deepEqual(metrics.cpuCores, [["2026-09-26T05:03:00Z", 0.93]]);
    assert.deepEqual(metrics.diskMb, []);
  });

  test("refuses a bad pod name before any request", async () => {
    const fake = fakeClient(() => ({}));
    await assert.rejects(new GcpSandboxTelemetry("proj", "outfitter-sandboxes", fake.client).metrics('a" OR "b', new Date(), new Date()), TelemetryUnavailable);
    assert.equal(fake.calls.length, 0);
  });
});

describe("GcpSandboxTelemetry: namespace", () => {
  test("queries the configured namespace, and refuses one that isn't a Kubernetes name", async () => {
    const fake = fakeClient(() => ({ timeSeries: [] }));
    await new GcpSandboxTelemetry("proj", "other-ns", fake.client).metrics("pod-1", new Date(), new Date());
    assert.match(fake.calls[0]!.params!.filter!, /resource.labels.namespace_name="other-ns"/);
    assert.throws(() => new GcpSandboxTelemetry("proj", 'x" OR "y'), /not a Kubernetes name/);
  });
});

describe("CachedSandboxTelemetry (#201 review)", () => {
  function countingInner(fail = false) {
    const counts = { logs: 0, metrics: 0 };
    const inner: SandboxTelemetry = {
      async logs(runId) {
        counts.logs++;
        if (fail) throw new TelemetryUnavailable("failed", "down");
        return { lines: [{ time: "t", severity: "INFO", message: runId }] };
      },
      async metrics() {
        counts.metrics++;
        return { memoryMb: [], cpuCores: [], diskMb: [] };
      },
    };
    return { inner, counts };
  }

  test("serves repeat calls from cache within the TTL, then asks again", async () => {
    let now = 1_000_000;
    const { inner, counts } = countingInner();
    const cached = new CachedSandboxTelemetry(inner, 20_000, 500, () => now);
    await cached.logs(RUN);
    await cached.logs(RUN);
    await cached.logs(RUN, { pageToken: "older" }); // a different page is a different key
    assert.equal(counts.logs, 2);
    now += 20_001;
    await cached.logs(RUN);
    assert.equal(counts.logs, 3);
  });

  test("a live run's moving metrics window shares one entry per minute", async () => {
    const now = Date.parse("2026-09-27T12:00:10Z");
    const { inner, counts } = countingInner();
    const cached = new CachedSandboxTelemetry(inner, 20_000, 500, () => now);
    const start = new Date("2026-09-27T11:00:00Z");
    await cached.metrics("pod-1", start, new Date("2026-09-27T12:00:10Z"));
    await cached.metrics("pod-1", start, new Date("2026-09-27T12:00:40Z"));
    assert.equal(counts.metrics, 1);
  });

  test("failures aren't cached, and the cache stays bounded", async () => {
    const failing = countingInner(true);
    const cached = new CachedSandboxTelemetry(failing.inner);
    await assert.rejects(cached.logs(RUN));
    await assert.rejects(cached.logs(RUN));
    assert.equal(failing.counts.logs, 2);

    const { inner, counts } = countingInner();
    const small = new CachedSandboxTelemetry(inner, 20_000, 2);
    for (const token of ["a", "b", "c"]) await small.logs(RUN, { pageToken: token });
    await small.logs(RUN, { pageToken: "a" }); // evicted as the oldest
    assert.equal(counts.logs, 4);
  });
});

describe("wire parsing", () => {
  test("toSeries sums series sharing a timestamp and sorts oldest first", () => {
    const series = toSeries(
      {
        timeSeries: [
          { points: [{ interval: { endTime: "2026-09-26T05:02:00Z" }, value: { int64Value: "1048576" } }, { interval: { endTime: "2026-09-26T05:01:00Z" }, value: { int64Value: "2097152" } }] },
          { points: [{ interval: { endTime: "2026-09-26T05:02:00Z" }, value: { int64Value: "1048576" } }] },
        ],
      },
      1 / (1024 * 1024),
    );
    assert.deepEqual(series, [["2026-09-26T05:01:00Z", 2], ["2026-09-26T05:02:00Z", 2]]);
  });

  test("toLogPage ignores a pod label that isn't a pod name", () => {
    const page = toLogPage({ entries: [{ timestamp: "t", textPayload: "x", resource: { labels: { pod_name: 'bad" name' } } }] });
    assert.equal(page.podName, undefined);
  });
});
