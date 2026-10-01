// Agent Engine memory usage (E9 §3.4): per-instance counts of memory calls and retrieved docs,
// logged once a day so they can be compared with the bill (retrieval is billed per doc).

export interface MemoryUsageCounts {
  day: string;
  search: number;
  context: number;
  save: number;
  recordTurn: number;
  /** Memories retrieved, as the server counted them (metadata.memory_counts) or as returned. */
  docs: number;
  errors: number;
}

function emptyCounts(day: string): MemoryUsageCounts {
  return { day, search: 0, context: 0, save: 0, recordTurn: 0, docs: 0, errors: 0 };
}

/** Per-instance counters, logged once when the UTC day turns (on the first call of the next day). */
export class MemoryUsage {
  private counts: MemoryUsageCounts;
  private readonly now: () => number;
  private readonly emit: (counts: MemoryUsageCounts) => void;

  constructor(opts: { now?: () => number; emit?: (counts: MemoryUsageCounts) => void } = {}) {
    this.now = opts.now ?? Date.now;
    this.emit = opts.emit ?? ((c) => console.log(JSON.stringify({ severity: "INFO", message: "agent engine memory usage", ...c })));
    this.counts = emptyCounts(this.today());
  }

  private today(): string {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  note(kind: "search" | "context" | "save" | "recordTurn", docs = 0, failed = false): void {
    const day = this.today();
    if (day !== this.counts.day) {
      const done = this.counts;
      this.counts = emptyCounts(day);
      if (done.search + done.context + done.save + done.recordTurn > 0) {
        try {
          this.emit(done);
        } catch {
          // A log line must never fail a memory call.
        }
      }
    }
    this.counts[kind] += 1;
    this.counts.docs += docs;
    if (failed) this.counts.errors += 1;
  }

  snapshot(): MemoryUsageCounts {
    return { ...this.counts };
  }
}

export const memoryUsage = new MemoryUsage();
