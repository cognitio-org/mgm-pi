/**
 * The sandbox's own memory use and limit (#187), so a run that is about to be OOM-killed leaves a
 * trace. Under GKE Sandbox the kill takes the whole gVisor sandbox, agentd included, so agentd
 * can't report the kill itself; it reports how close the sandbox came, and the api explains a run
 * that then went silent (runs.ts's reconciler).
 *
 * gVisor emulates cgroup v1 inside the sandbox: memory.usage_in_bytes is everything the sandbox
 * uses (every process's heap, pi's and the model's commands alike) and memory.limit_in_bytes is
 * the pod's limit. Checked on a live GKE sandbox: 2147483648 for a 2Gi pod, ~171 MB idle, and a
 * 200 MB file written to /workspace does not move it (the rootfs overlay is disk-backed), so this
 * measures processes, which is what spiked in the run #187 lost. cgroup v2 and /proc/meminfo are
 * fallbacks for other runtimes (Cloud Run, a laptop); anything unreadable gives undefined.
 */
import { readFileSync } from "node:fs";

export interface SandboxMemory {
  usedMb: number;
  limitMb: number;
}

type Read = (path: string) => string;

const MIB = 1024 * 1024;
/** cgroup v1 reports "no limit" as a huge number (9223372036854771712); treat anything past 1 TiB as unset. */
const NO_LIMIT_BYTES = 2 ** 40;

function bytes(read: Read, path: string): number | undefined {
  try {
    const text = read(path).trim();
    if (!/^\d+$/.test(text)) return undefined;
    const value = Number(text);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function fromMeminfo(read: Read): { totalBytes: number; usedBytes: number } | undefined {
  let text: string;
  try {
    text = read("/proc/meminfo");
  } catch {
    return undefined;
  }
  const kb = (key: string) => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(text);
    return match ? Number(match[1]) * 1024 : undefined;
  };
  const total = kb("MemTotal");
  const available = kb("MemAvailable");
  if (total === undefined || available === undefined) return undefined;
  return { totalBytes: total, usedBytes: total - available };
}

/** Reclaimable file cache the kernel can drop before an OOM kill: cgroup v1's total_inactive_file
 * or v2's inactive_file in memory.stat. Subtracting it gives the working set the kubelet itself
 * uses for OOM decisions, so file cache on a normal kernel (Cloud Run, a laptop) doesn't read as
 * pressure. gVisor's emulated cgroup has no memory.stat; there this is 0 and changes nothing. */
function inactiveFile(read: Read, statPath: string, key: string): number {
  try {
    const match = new RegExp(`^${key} (\\d+)$`, "m").exec(read(statPath));
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

function cgroupUsed(read: Read): number | undefined {
  const v1 = bytes(read, "/sys/fs/cgroup/memory/memory.usage_in_bytes");
  if (v1 !== undefined) return Math.max(0, v1 - inactiveFile(read, "/sys/fs/cgroup/memory/memory.stat", "total_inactive_file"));
  const v2 = bytes(read, "/sys/fs/cgroup/memory.current");
  if (v2 !== undefined) return Math.max(0, v2 - inactiveFile(read, "/sys/fs/cgroup/memory.stat", "inactive_file"));
  return undefined;
}

export function readSandboxMemory(read: Read = (path) => readFileSync(path, "utf8")): SandboxMemory | undefined {
  let used = cgroupUsed(read);
  let limit = bytes(read, "/sys/fs/cgroup/memory/memory.limit_in_bytes") ?? bytes(read, "/sys/fs/cgroup/memory.max");
  if (limit !== undefined && limit >= NO_LIMIT_BYTES) limit = undefined;
  if (used === undefined || limit === undefined) {
    const meminfo = fromMeminfo(read);
    used ??= meminfo?.usedBytes;
    limit ??= meminfo?.totalBytes;
  }
  if (used === undefined || limit === undefined || limit <= 0) return undefined;
  return { usedMb: Math.round(used / MIB), limitMb: Math.round(limit / MIB) };
}

/** Samples often enough to catch a spike between heartbeats (one rose ~500 MB a minute in #187)
 * and hands the peak to each heartbeat. */
export class SandboxMemoryPeak {
  private peak: SandboxMemory | undefined;

  constructor(private readonly read: () => SandboxMemory | undefined = readSandboxMemory) {}

  sample(): void {
    const now = this.read();
    if (now && (!this.peak || now.usedMb >= this.peak.usedMb)) this.peak = now;
  }

  /** The highest reading since the last call, then starts over. Undefined when nothing was readable. */
  take(): SandboxMemory | undefined {
    this.sample();
    const peak = this.peak;
    this.peak = undefined;
    return peak;
  }
}
