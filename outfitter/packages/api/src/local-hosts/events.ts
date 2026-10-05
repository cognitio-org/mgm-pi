// Local Host (epic #378, docs/specs/local-host.md §5): the seam between the host registry (task A,
// #382/#383) and the router reconciliation (task B, #384). The registry announces a host change
// here; B registers a listener in server.ts. The tick (`POST /api/hooks/tick`) calls sweep(), which
// runs every listener's sweep: A's ngrok clean-up and B's full reconcile. Neither task imports the
// other's module, so they are built and changed independently.
//
// Spec-owned (local-host.md §9), like central/device-lifecycle.ts.
//
// A listener that fails or is slow never fails a heartbeat: the failure is logged and reported in
// the heartbeat's `problems`, and the next sweep repairs whatever it left undone.

import type { LocalHost } from "../store/local-hosts.ts";

export type LocalHostChangeReason =
  /** A heartbeat changed routerFingerprint (models, status, sharing, tunnel). */
  | "heartbeat"
  /** New credentials: a new public URL or bearer. */
  | "credentials"
  /** DELETE /api/local-hosts/:id: `host` is the record as it was; the store keeps only a tombstone
   * (`deletedAt`, sharing off, no models) that holds its router prefix for the same user (§1.8). */
  | "deleted"
  /** The device that owned it was revoked; `host.revokedAt` is set. */
  | "device-revoked";

export interface LocalHostChange {
  reason: LocalHostChangeReason;
  /** The record after the change (for "deleted", the last one before it). */
  host: LocalHost;
  /** The stored record before the change, when there was one. */
  previous?: LocalHost;
}

export interface LocalHostListener {
  /** Short, for logs and `problems`: "router", "tunnel". */
  name: string;
  /** Called after the change is stored. Must be idempotent: a retry, or a second instance handling
   * the same host, must leave the same result. */
  onChange?(change: LocalHostChange): Promise<void>;
  /** Called from the tick. Returns counts for the tick's answer (never secrets). */
  sweep?(now: Date): Promise<Record<string, number> | void>;
}

/** How long changed() waits for one listener before reporting it as still running. The work goes
 * on; the heartbeat answer just doesn't wait for it. Longer than one upstream call's timeout (the
 * router listener makes a list call plus writes, each capped shorter), so a slow upstream shows as
 * its own error rather than "still updating". Kernal's heartbeat request waits 30 s (§1.4). */
export const LISTENER_TIMEOUT_MS = 20_000;

export class LocalHostEvents {
  private readonly listeners: LocalHostListener[] = [];
  private readonly log: (msg: string, err?: unknown) => void;
  private readonly timeoutMs: number;

  constructor(log: (msg: string, err?: unknown) => void = () => {}, opts: { timeoutMs?: number } = {}) {
    this.log = log;
    this.timeoutMs = opts.timeoutMs ?? LISTENER_TIMEOUT_MS;
  }

  register(listener: LocalHostListener): void {
    this.listeners.push(listener);
  }

  /** Every listener's onChange, in registration order. Resolves with one problem line per listener
   * that failed or timed out; never throws. */
  async changed(change: LocalHostChange): Promise<{ problems: string[] }> {
    const problems: string[] = [];
    for (const l of this.listeners) {
      if (!l.onChange) continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const work = l.onChange(change).then(() => "done" as const);
      // The work may still fail after the timeout: log it then too, never let it go unhandled.
      work.catch((err) => this.log(`local hosts: ${l.name} failed on ${change.reason} of ${change.host.id}`, err));
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), this.timeoutMs);
        timer.unref?.();
      });
      try {
        const outcome = await Promise.race([work, timeout]);
        if (outcome === "timeout") problems.push(`${l.name}: still updating`);
      } catch (err) {
        problems.push(`${l.name}: ${problemText(err)}`);
      } finally {
        clearTimeout(timer);
      }
    }
    return { problems };
  }

  /** Every listener's sweep; a failing one is logged and left out of the result. */
  async sweep(now: Date = new Date()): Promise<Record<string, Record<string, number>>> {
    const out: Record<string, Record<string, number>> = {};
    for (const l of this.listeners) {
      if (!l.sweep) continue;
      try {
        const counts = await l.sweep(now);
        if (counts) out[l.name] = counts;
      } catch (err) {
        this.log(`local hosts: ${l.name} sweep failed`, err);
      }
    }
    return out;
  }
}

/** An error as one short line. A listener must not put a secret in its error messages. */
function problemText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split("\n")[0].slice(0, 200) || "failed";
}
