import { useEffect, useRef, useState } from "react";
import { api, type PiEntry, type StartupSummary } from "../api/client.ts";
import type { RawUiRequest } from "../components/UiRequestPanel.tsx";

export interface StreamState {
  /** #255: the initial history fetch has finished (or failed). */
  entriesLoaded: boolean;
  entries: PiEntry[];
  runState?: string;
  /** Bug 3 (docs/reports/cloud-fixes.md): the failed run's own reason, when runState is "failed" --
   * carried by the status frame's `reason` field so LOAD ERROR can say why. */
  runStateReason?: string;
  /** Bug 7 (docs/reports/cloud-fixes.md): the status frame's optional `detail` -- agentd now uses
   * it to surface a pi RPC command (prompt/steer/follow_up) that pi rejected, which used to vanish
   * silently. */
  statusDetail?: string;
  pendingUiRequest: RawUiRequest | null;
  costEstimate?: number;
  /** The run's start-up timing from status events: undefined until one says, null for none. */
  startup?: StartupSummary | null;
  /** When (this browser's clock, ms) agentd last spoke, heartbeats included -- from `liveness`. */
  agentSeenAt?: number;
  /** When (this browser's clock, ms) pi last wrote an entry or streamed an event -- from `liveness`. */
  piActiveAt?: number;
  /** #285: the open message's thinking text, or null when there isn't one. Empty string means
   * a thinking block has started and no words have arrived yet. Not an entry: the message
   * hasn't been stored. */
  liveThought: string | null;
}

/** One `liveness` frame (sse.ts) on this browser's clock. The api sends ages, not timestamps, so
 * the two clocks never have to agree. Absent ages stay undefined. */
export function livenessTimes(
  data: { seenAgoMs?: number; activityAgoMs?: number },
  now: number,
): { agentSeenAt?: number; piActiveAt?: number } {
  return {
    agentSeenAt: typeof data.seenAgoMs === "number" ? now - data.seenAgoMs : undefined,
    piActiveAt: typeof data.activityAgoMs === "number" ? now - data.activityAgoMs : undefined,
  };
}

/** Folds one status event's `startup` into the current one: absent keeps it (most status events
 * don't carry it), null drops it (a new run), an object replaces it. */
export function nextStartup(
  current: StartupSummary | null | undefined,
  data: { startup?: StartupSummary | null },
): StartupSummary | null | undefined {
  return "startup" in data ? (data.startup ?? null) : current;
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

/** Folds one status event's `detail` into the note currently on screen: `undefined` (the field was
 * absent) keeps what is there, `null` clears it, a string replaces it. Exported as a pure function
 * so the three-way rule is testable without a fake EventSource, same as mergeEntries. */
export function nextStatusDetail(current: string | undefined, incoming: string | null | undefined): string | undefined {
  if (incoming === undefined) return current;
  return incoming ?? undefined;
}

/** Dialog methods pi blocks on. Display-only methods (notify, setStatus, setWidget, setTitle,
 * set_editor_text) are not a question -- same set as agentlink.ts, which the web package cannot
 * import. */
const INTERACTIVE_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);

/** The pending question after one SSE `event` payload. Only select/confirm/input/editor stick.
 * A frame with no id, or `cleared: true` (sse.ts, once Run.pendingUiRequest disappears), drops it.
 * Exported so the rule is testable without a fake EventSource. */
export function nextPendingUiRequest(
  current: RawUiRequest | null,
  event: { type?: string; t?: string; id?: unknown; method?: unknown; cleared?: unknown; [key: string]: unknown },
): RawUiRequest | null {
  const eventType = event.type ?? event.t;
  if (eventType !== "extension_ui_request") return current;
  if (typeof event.id !== "string" || event.cleared === true) return null;
  if (typeof event.method === "string" && INTERACTIVE_UI_METHODS.has(event.method)) return event as RawUiRequest;
  return current;
}

/** Joined thinking text of the latest assistant message, or null when that message has no
 * thinking block (or there isn't one). Matches the api's live-thought join. */
function latestAssistantThinking(entries: PiEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return null;
    const parts: string[] = [];
    let saw = false;
    for (const block of content) {
      if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "thinking") continue;
      saw = true;
      const text = (block as { thinking?: unknown }).thinking;
      if (typeof text === "string" && text.length > 0) parts.push(text);
    }
    return saw ? parts.join("\n\n") : null;
  }
  return null;
}

/** The streamed thought after one `live_thought` frame. Null clears it. A snapshot equal to
 * the thinking already stored on the latest assistant message is that round landing, not a
 * new one -- otherwise a poll that races the entry would reopen the bubble. */
export function nextLiveThought(incoming: string | null, entries: PiEntry[]): string | null {
  if (incoming === null) return null;
  const persisted = latestAssistantThinking(entries);
  if (persisted !== null && persisted === incoming) return null;
  return incoming;
}

export function isAssistantMessage(entry: PiEntry): boolean {
  if (entry.type !== "message") return false;
  const message = entry.message;
  return typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant";
}

/** A stopped or failed run is not waiting on an answer. Any other state leaves the question. */
export function nextPendingOnStatus(current: RawUiRequest | null, state: string | undefined): RawUiRequest | null {
  if (state === "stopped" || state === "failed") return null;
  return current;
}

/** Loads a session's entries, then keeps them (plus run state and pending UI requests) live via
 * GET /api/sessions/:id/stream (SSE: event: entry|event|status|spend|checkpoint -- protocol.md). */
export function useSessionStream(sessionId: string): StreamState {
  const [entries, setEntries] = useState<PiEntry[]>([]);
  const [runState, setRunState] = useState<string | undefined>(undefined);
  const [runStateReason, setRunStateReason] = useState<string | undefined>(undefined);
  const [statusDetail, setStatusDetail] = useState<string | undefined>(undefined);
  const [pendingUiRequest, setPendingUiRequest] = useState<StreamState["pendingUiRequest"]>(null);
  const [costEstimate, setCostEstimate] = useState<number | undefined>(undefined);
  const [startup, setStartup] = useState<StartupSummary | null | undefined>(undefined);
  const [agentSeenAt, setAgentSeenAt] = useState<number | undefined>(undefined);
  const [piActiveAt, setPiActiveAt] = useState<number | undefined>(undefined);
  const [liveThought, setLiveThought] = useState<string | null>(null);
  const entryIds = useRef<Set<string>>(new Set());
  // Event handlers read this. A setState updater writes it before the handler returns, so a
  // live_thought frame that arrives in the same tick as its entry still sees that entry.
  const entriesRef = useRef<PiEntry[]>([]);
  // #255: the history has been fetched (or the fetch failed). Until then `entries` is only what
  // SSE has sent, so nothing can tell history from new replies yet.
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    entryIds.current = new Set();
    setEntries([]);
    setLoaded(false);
    setRunState(undefined);
    setRunStateReason(undefined);
    setStatusDetail(undefined);
    setPendingUiRequest(null);
    setCostEstimate(undefined);
    setStartup(undefined);
    setAgentSeenAt(undefined);
    setPiActiveAt(undefined);
    setLiveThought(null);
    entriesRef.current = [];

    api
      .entries(sessionId)
      .then((initial) => {
        if (cancelled) return;
        for (const e of initial) entryIds.current.add(e.id);
        setEntries((prev) => {
          const next = mergeEntries(prev, initial);
          entriesRef.current = next;
          return next;
        });
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });

    const source = new EventSource(api.streamUrl(sessionId));

    source.addEventListener("status", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as {
        state?: string;
        reason?: string;
        detail?: string | null;
        startup?: StartupSummary | null;
      };
      if (data.state) setRunState(data.state);
      // The bubble is only for a running turn. Idle, stopped, and failed drop whatever was streaming.
      if (data.state && data.state !== "running") setLiveThought(null);
      setRunStateReason(data.reason);
      // Three cases, not two: absent means "nothing new to say" and the last note stands (agentd
      // sends state-only status frames all the time), an explicit null means "this is a different
      // run now, drop it" (sse.ts sends one on the first poll that sees a new run -- without it, a
      // refused run's note stayed pinned over its replacement), and a string replaces it.
      setStatusDetail((prev) => nextStatusDetail(prev, data.detail));
      setPendingUiRequest((prev) => nextPendingOnStatus(prev, data.state));
      setStartup((prev) => nextStartup(prev, data));
    });

    source.addEventListener("entry", (ev) => {
      const entry = JSON.parse((ev as MessageEvent).data) as PiEntry;
      if (entryIds.current.has(entry.id)) return;
      entryIds.current.add(entry.id);
      setEntries((prev) => {
        const next = [...prev, entry];
        entriesRef.current = next;
        return next;
      });
      // This message is the transcript's now. The streamed copy would sit beside it.
      if (isAssistantMessage(entry)) setLiveThought(null);
    });

    source.addEventListener("live_thought", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { text?: unknown };
      const text = typeof data.text === "string" ? data.text : null;
      setLiveThought(nextLiveThought(text, entriesRef.current));
    });

    source.addEventListener("event", (ev) => {
      const event = JSON.parse((ev as MessageEvent).data) as {
        type?: string;
        t?: string;
        id?: unknown;
        method?: unknown;
        cleared?: unknown;
        [key: string]: unknown;
      };
      setPendingUiRequest((prev) => nextPendingUiRequest(prev, event));
    });

    source.addEventListener("liveness", (ev) => {
      // Each frame describes the active run as a whole: an age it leaves out is cleared, so a new
      // run's first frame (agentd connected, pi not yet active) drops the previous run's times.
      const times = livenessTimes(JSON.parse((ev as MessageEvent).data), Date.now());
      setAgentSeenAt(times.agentSeenAt);
      setPiActiveAt(times.piActiveAt);
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

  return { entries, entriesLoaded: loaded, runState, runStateReason, statusDetail, pendingUiRequest, costEstimate, startup, agentSeenAt, piActiveAt, liveThought };
}
