import { useEffect, useRef, useState } from "react";
import { api, type PiEntry } from "../api/client.ts";
import type { RawUiRequest } from "../components/UiRequestPanel.tsx";

export interface StreamState {
  entries: PiEntry[];
  runState?: string;
  pendingUiRequest: RawUiRequest | null;
  costEstimate?: number;
}

/** Code review N1 (docs/reports/code-review-pr15.md): the initial `GET .../entries` fetch and the
 * SSE `EventSource` open essentially back-to-back with no ordering guarantee. If an `entry` SSE
 * event lands (and is appended) before the initial fetch resolves, unconditionally replacing
 * `entries` with the fetch result would silently drop it. Merge instead: `initial` is already in
 * tree order (per the API's own contract), so it's authoritative for anything it contains; any
 * entry already in `current` but missing from `initial` arrived over SSE in the gap and is
 * appended after, preserving the order it arrived in. Exported as a pure function so it's testable
 * without a fake EventSource. */
export function mergeEntries(current: PiEntry[], initial: PiEntry[]): PiEntry[] {
  const initialIds = new Set(initial.map((e) => e.id));
  const streamedBeforeInitial = current.filter((e) => !initialIds.has(e.id));
  return [...initial, ...streamedBeforeInitial];
}

/** Loads a session's entries, then keeps them (plus run state and pending UI requests) live via
 * GET /api/sessions/:id/stream (SSE: event: entry|event|status|spend|checkpoint -- protocol.md). */
export function useSessionStream(sessionId: string): StreamState {
  const [entries, setEntries] = useState<PiEntry[]>([]);
  const [runState, setRunState] = useState<string | undefined>(undefined);
  const [pendingUiRequest, setPendingUiRequest] = useState<StreamState["pendingUiRequest"]>(null);
  const [costEstimate, setCostEstimate] = useState<number | undefined>(undefined);
  const entryIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    entryIds.current = new Set();
    setEntries([]);
    setRunState(undefined);
    setPendingUiRequest(null);
    setCostEstimate(undefined);

    api.entries(sessionId).then((initial) => {
      if (cancelled) return;
      for (const e of initial) entryIds.current.add(e.id);
      setEntries((prev) => mergeEntries(prev, initial));
    });

    const source = new EventSource(api.streamUrl(sessionId));

    source.addEventListener("status", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { state?: string };
      if (data.state) setRunState(data.state);
    });

    source.addEventListener("entry", (ev) => {
      const entry = JSON.parse((ev as MessageEvent).data) as PiEntry;
      if (entryIds.current.has(entry.id)) return;
      entryIds.current.add(entry.id);
      setEntries((prev) => [...prev, entry]);
    });

    source.addEventListener("event", (ev) => {
      const event = JSON.parse((ev as MessageEvent).data) as { type?: string; t?: string; id?: string; [key: string]: unknown };
      const eventType = event.type ?? event.t;
      if (eventType === "extension_ui_request" && typeof event.id === "string" && typeof event.method === "string") {
        setPendingUiRequest(event as unknown as RawUiRequest);
      }
    });

    source.addEventListener("spend", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { estimate?: number };
      if (typeof data.estimate === "number") setCostEstimate(data.estimate);
    });

    return () => {
      cancelled = true;
      source.close();
    };
  }, [sessionId]);

  return { entries, runState, pendingUiRequest, costEstimate };
}
