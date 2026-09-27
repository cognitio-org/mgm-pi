import { test } from "node:test";
import assert from "node:assert/strict";
import { readSandboxMemory, SandboxMemoryPeak, type SandboxMemory } from "../src/sandbox-memory.js";

function files(map: Record<string, string>) {
  return (path: string) => {
    if (path in map) return map[path]!;
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  };
}

test("readSandboxMemory: gVisor's cgroup v1 files, as read on a live 2Gi GKE sandbox", () => {
  const read = files({
    "/sys/fs/cgroup/memory/memory.usage_in_bytes": "171085824\n",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes": "2147483648\n",
  });
  assert.deepEqual(readSandboxMemory(read), { usedMb: 163, limitMb: 2048 });
});

test("readSandboxMemory: cgroup v2 when v1 is absent", () => {
  const read = files({ "/sys/fs/cgroup/memory.current": "1073741824", "/sys/fs/cgroup/memory.max": "4294967296" });
  assert.deepEqual(readSandboxMemory(read), { usedMb: 1024, limitMb: 4096 });
});

test("readSandboxMemory: an unlimited cgroup takes the limit from /proc/meminfo", () => {
  const read = files({
    "/sys/fs/cgroup/memory/memory.usage_in_bytes": "524288000",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712",
    "/proc/meminfo": "MemTotal:        2097152 kB\nMemFree:         1929216 kB\nMemAvailable:    1929216 kB\n",
  });
  assert.deepEqual(readSandboxMemory(read), { usedMb: 500, limitMb: 2048 });
  // v2's "max" is not a number, so the same fallback applies.
  const v2 = files({
    "/sys/fs/cgroup/memory.current": "524288000",
    "/sys/fs/cgroup/memory.max": "max",
    "/proc/meminfo": "MemTotal:        2097152 kB\nMemAvailable:    1048576 kB\n",
  });
  assert.deepEqual(readSandboxMemory(v2), { usedMb: 500, limitMb: 2048 });
});

test("readSandboxMemory: /proc/meminfo alone gives used = total - available", () => {
  const read = files({ "/proc/meminfo": "MemTotal:        4194304 kB\nMemFree:  100 kB\nMemAvailable:    3145728 kB\n" });
  assert.deepEqual(readSandboxMemory(read), { usedMb: 1024, limitMb: 4096 });
});

test("readSandboxMemory: nothing readable is undefined, never a throw", () => {
  assert.equal(readSandboxMemory(files({})), undefined);
  assert.equal(readSandboxMemory(files({ "/proc/meminfo": "garbage" })), undefined);
});

test("SandboxMemoryPeak: take() returns the highest sample since the last take, then starts over", () => {
  const readings: (SandboxMemory | undefined)[] = [
    { usedMb: 300, limitMb: 2048 },
    { usedMb: 1800, limitMb: 2048 },
    { usedMb: 400, limitMb: 2048 },
    { usedMb: 350, limitMb: 2048 }, // read by take() itself
    { usedMb: 200, limitMb: 2048 }, // the next take()
  ];
  const peak = new SandboxMemoryPeak(() => readings.shift());
  peak.sample();
  peak.sample();
  peak.sample();
  assert.deepEqual(peak.take(), { usedMb: 1800, limitMb: 2048 }, "a spike between heartbeats is kept");
  assert.deepEqual(peak.take(), { usedMb: 200, limitMb: 2048 });
});

test("SandboxMemoryPeak: an unreadable runtime gives undefined", () => {
  assert.equal(new SandboxMemoryPeak(() => undefined).take(), undefined);
});
