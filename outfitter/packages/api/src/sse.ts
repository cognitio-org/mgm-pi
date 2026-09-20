// Tiny SSE helper: one hub of per-session subscriber lists, written to directly (no framework
// dependency beyond Fastify's raw response). See protocol.md "browser <-> api": GET
// /api/sessions/:id/stream sends `status` on connect, then live entry|event|status|spend|checkpoint.

import type { FastifyReply } from "fastify";

export type SseEventType = "entry" | "event" | "status" | "spend" | "checkpoint";

export interface SseEvent {
  type: SseEventType;
  data: unknown;
}

function formatFrame({ type, data }: SseEvent): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export class SseHub {
  private readonly subscribers = new Map<string, Set<FastifyReply>>();

  /** Starts the SSE response and registers it for the channel until the client disconnects. */
  subscribe(channel: string, reply: FastifyReply): void {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Fastify buffers the response by default; flush headers immediately so the browser sees the
    // stream open right away instead of after the first event.
    reply.raw.flushHeaders?.();

    let set = this.subscribers.get(channel);
    if (!set) {
      set = new Set();
      this.subscribers.set(channel, set);
    }
    set.add(reply);

    reply.raw.on("close", () => {
      set?.delete(reply);
      if (set && set.size === 0) this.subscribers.delete(channel);
    });
  }

  publish(channel: string, event: SseEvent): void {
    const set = this.subscribers.get(channel);
    if (!set || set.size === 0) return;
    const frame = formatFrame(event);
    for (const reply of set) reply.raw.write(frame);
  }

  subscriberCount(channel: string): number {
    return this.subscribers.get(channel)?.size ?? 0;
  }
}
