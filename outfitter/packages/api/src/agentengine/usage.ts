// Agent Engine memory usage (E9 §3.4): per-instance counts of memory calls and retrieved docs, to
// compare with the bill (retrieval is billed per doc). Cloud Run instances come and go, so a count
// held until the day turns would mostly be lost: each instance logs its counts for every UTC hour
// that had any (on the first call of a later hour), and whatever it holds when it shuts down
// (flush, from server.ts's onClose). Sum the `agent engine memory usage` lines per day in Cloud
// Logging.

export interface MemoryUsageCounts {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** UTC hour the counts are for, YYYY-MM-DDTHH. */
  hour: string;
  search: number;
  context: number;
  save: number;
  recordTurn: number;
  /** Memories retrieved, as the server counted them (metadata.memory_counts) or as returned. */
  docs: number;
  errors: number;
}

function emptyCounts(hour: string): MemoryUsageCounts {
  return { day: hour.slice(0, 10), hour, search: 0, context: 0, save: 0, recordTurn: 0, docs: 0, errors: 0 };
}

export class MemoryUsage {
  private counts: MemoryUsageCounts;
  private readonly now: () => number;
  private readonly emit: (counts: MemoryUsageCounts) => void;

  constructor(opts: { now?: () => number; emit?: (counts: MemoryUsageCounts) => void } = {}) {
    this.now = opts.now ?? Date.now;
    this.emit = opts.emit ?? ((c) => console.log(JSON.stringify({ severity: "INFO", message: "agent engine memory usage", ...c })));
    this.counts = emptyCounts(this.hourNow());
  }

  private hourNow(): string {
    return new Date(this.now()).toISOString().slice(0, 13);
  }

  note(kind: "search" | "context" | "save" | "recordTurn", docs = 0, failed = false): void {
    const hour = this.hourNow();
    if (hour !== this.counts.hour) {
      this.flush();
      this.counts = emptyCounts(hour);
    }
    this.counts[kind] += 1;
    this.counts.docs += docs;
    if (failed) this.counts.errors += 1;
  }

  /** Logs the counts held now, if any, and starts again from zero. */
  flush(): void {
    const done = this.counts;
    this.counts = emptyCounts(this.hourNow());
    if (done.search + done.context + done.save + done.recordTurn === 0) return;
    try {
      this.emit(done);
    } catch {
      // A log line must never fail a memory call.
    }
  }

  snapshot(): MemoryUsageCounts {
    return { ...this.counts };
  }
}

export const memoryUsage = new MemoryUsage();
