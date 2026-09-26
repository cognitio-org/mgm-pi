/**
 * hello.boot (protocol.ts's BootTimings): the durations main.ts measures while the sandbox boots,
 * all on agentd's own clock. A pure function so the arithmetic is testable without spawning main.
 */
import type { BootTimings } from "./protocol.js";

export interface BootClock {
  /** Date.now() as the hello is built. */
  now: number;
  /** main entered. */
  bootStart: number;
  /** main entered -> run-independent setup done. */
  setupMs: number;
  /** When the assignment became known: bootStart on the env path, the claim on a warm pod. */
  assignedAt: number;
  /** A warm pod's wait to be claimed; undefined on the env path. */
  assignmentWaitMs?: number;
  /** This connect attempt's identity-token fetch, once it finished. */
  identityTokenMs?: number;
  tokenFetchedAt?: number;
}

export function bootTimings(c: BootClock): BootTimings {
  const ms = (n: number) => Math.max(0, Math.round(n));
  return {
    bootMs: ms(c.now - c.bootStart),
    setupMs: ms(c.setupMs),
    ...(c.assignmentWaitMs !== undefined ? { assignmentWaitMs: ms(c.assignmentWaitMs) } : {}),
    sinceAssignedMs: ms(c.now - c.assignedAt),
    ...(c.identityTokenMs !== undefined ? { identityTokenMs: ms(c.identityTokenMs) } : {}),
    ...(c.tokenFetchedAt !== undefined ? { connectMs: ms(c.now - c.tokenFetchedAt) } : {}),
  };
}
