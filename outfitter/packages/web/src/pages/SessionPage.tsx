import { useEffect, useRef, useState, type UIEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, type ModelRow, type SessionDetail } from "../api/client.ts";
import { useSessionStream } from "../hooks/useSessionStream.ts";
import { useProviders } from "../hooks/useProviders.ts";
import { entriesToViews } from "../lib/entry-view.ts";
import { groupBeats, liveThinkingItem, railThinkingText } from "../lib/beats.ts";
import { isThoughtBubbleEnabled, setThoughtBubbleEnabled } from "../lib/thought-bubble.ts";
import { groupThinkingBlocks } from "../lib/thinking.ts";
import { deriveSessionHeader } from "../lib/session-header.ts";
import {
  contextMeterMessage,
  deriveTransportStatusLine,
  runStateNote,
  transportStatusLine,
  type TransportOutcome,
} from "../lib/retro-errors.ts";
import { sessionLamp } from "../lib/session-lamp.ts";
import { githubCluster, looseRepoClause } from "../lib/session-facts.ts";
import { toApiErrorState } from "../lib/api-error.ts";
import { EntryItem } from "../components/EntryItem.tsx";
import { BeatView, StreamedThought, YouMark, beatOpensVsCode } from "../components/TranscriptRail.tsx";
import { ThoughtBubbleToggle } from "../components/ThoughtBubbleToggle.tsx";
import { Composer } from "../components/Composer.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import { GithubChip } from "../components/GithubChip.tsx";
import { PreviewChips } from "../components/PreviewChips.tsx";
import { IdeChip } from "../components/IdeChip.tsx";
import { IdeProvider } from "../components/IdeProvider.tsx";
import { StartupTime } from "../components/StartupTime.tsx";
import { NerdOutPanel } from "../components/NerdOutPanel.tsx";
import { TransportDot } from "../components/TransportDot.tsx";
import { UiRequestPanel } from "../components/UiRequestPanel.tsx";
import { Working } from "../components/Working.tsx";
import { NotFoundError } from "../components/NotFoundError.tsx";
import { SystemErrorDialog, type ApiErrorState } from "../components/SystemErrorDialog.tsx";
import { DeviceNotPresent } from "../components/DeviceNotPresent.tsx";
import { withFloppySound } from "../lib/floppy-sound.ts";
import { floppyActions, transport, transportLabel } from "../lib/vocabulary.ts";
import { FormatFloppyDialog } from "../components/FormatFloppyDialog.tsx";
import { deriveSessionActivity, nextSendAnchor, notePendingRunState, type PendingSend } from "../lib/send-status.ts";
import { useChromeCompanion } from "../hooks/useChromeCompanion.ts";
import { teleportCommand } from "../lib/webmcp.ts";
import {
  HtmlPreviewAccessContext,
  beatEntryId,
  previewAccessByEntry,
  previewAccessFor,
} from "../lib/html-preview-access.ts";

type PendingAction = "abort" | "stop" | "wake" | null;

/** How long a just-finished BREAK/LOAD ERROR outcome stays on the status line before it reverts to
 * READY. -- long enough to read, short enough that it doesn't linger past its relevance. */
const OUTCOME_FLASH_MS = 3000;

export function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const sessionId = id ?? "";
  // ?expandThinking=1 defaults every collapsed thinking row open -- used only to drive a
  // screenshot of the expanded state (docs/reports/mobile-desk.md); not otherwise surfaced in the
  // UI.
  const [searchParams] = useSearchParams();
  const defaultThinkingExpanded = searchParams.get("expandThinking") === "1";
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [apiError, setApiError] = useState<ApiErrorState | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedGuruId, setCopiedGuruId] = useState(false);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [transportOutcome, setTransportOutcome] = useState<TransportOutcome | null>(null);
  const {
    entries,
    entriesLoaded,
    runState,
    runStateReason,
    statusDetail,
    pendingUiRequest,
    costEstimate,
    startup: streamStartup,
    agentSeenAt,
    piActiveAt,
    liveThought: streamedThought,
  } = useSessionStream(sessionId);
  const { providers } = useProviders();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The status line under the title bar hides once the person scrolls. The jump to the
  // latest entry is not that scroll -- the facts stay up until they move.
  const [compact, setCompact] = useState(false);
  // Scroll position the page jumped to on its own. Events that only report that spot
  // are not the person scrolling, so they must not tuck the status line away.
  const landedAt = useRef<number | null>(null);
  // #285: follow a growing thought only when the reader was already at the bottom.
  const followThought = useRef(true);
  // Cloud-fixes 11: the message just sent, until its stored entry and reply arrive.
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null);
  // Last time the page saw progress (a new entry, a run state change, or pi activity from the
  // `liveness` frame) -- the work/wake timeouts count from here. `now` ticks while something is in
  // flight so a timeout can fire.
  const [lastProgressAt, setLastProgressAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const chromePlace = useChromeCompanion(sessionId);
  const [splitTargets, setSplitTargets] = useState<{ id: string; name?: string }[]>([]);
  const [splitTarget, setSplitTarget] = useState("");
  // #198: the "nerd out" panel, closed on every visit so it never crowds the transcript. Held as
  // the session it was opened on, so moving to another session closes it in the same render --
  // it never renders, or fetches, with one session's id and the other's run.
  const [nerdOutFor, setNerdOutFor] = useState<string | null>(null);
  const nerdOut = nerdOutFor === sessionId;
  // #285: optional live thought bubble. A display choice on this browser, remembered like the
  // floppy-drive sound. Off leaves thinking on the rail glyph only.
  const [thoughtBubbles, setThoughtBubbles] = useState(() => isThoughtBubbleEnabled());
  const navigate = useNavigate();
  // #209: Archive, Restore and Format. Archived floppies are read-only (api 409s wake and send).
  const [shelving, setShelving] = useState<"archive" | "restore" | null>(null);
  const [formatOpen, setFormatOpen] = useState(false);
  // The route reuses this component across sessions, so an archive that returns after the user
  // moved on must not write its session into the next one's page.
  const currentSessionId = useRef(sessionId);
  currentSessionId.current = sessionId;

  // The route reuses this component when navigating from one session to another (App.tsx's
  // /sessions/:id has no key), so a pending send must not follow the user into the next session:
  // its baseline indexes the old session's entries and its optimistic row would show there.
  useEffect(() => {
    setPendingSend(null);
    setLastProgressAt(Date.now());
    setCompact(false);
    setFormatOpen(false);
    setShelving(null);
  }, [sessionId]);

  useEffect(() => {
    if (!chromePlace.ready || !chromePlace.split) return;
    let cancelled = false;
    api
      .sessions()
      .then((rows) => {
        if (cancelled) return;
        const others = rows
          .filter((row) => row.id !== sessionId)
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
        setSplitTargets(others.map((row) => ({ id: row.id, name: row.name })));
        setSplitTarget((current) => (others.some((row) => row.id === current) ? current : (others[0]?.id ?? "")));
      })
      .catch(() => {
        if (!cancelled) {
          setSplitTargets([]);
          setSplitTarget("");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [chromePlace.ready, chromePlace.split, sessionId]);

  useEffect(() => {
    setLastProgressAt(Date.now());
  }, [entries.length]);

  // pi streaming a token or starting a tool is progress too, though no entry lands until the step
  // ends (#182). Only forward: an older activity time never rewinds the clock.
  useEffect(() => {
    if (piActiveAt !== undefined) setLastProgressAt((prev) => Math.max(prev, piActiveAt));
  }, [piActiveAt]);

  useEffect(() => {
    setLastProgressAt(Date.now());
    setPendingSend((p) => notePendingRunState(p, runState));
    // Held mail (cloud-fixes 13) changes with run lifecycle; refresh the session detail with it.
    if (runState) loadSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runState]);

  const activity = deriveSessionActivity({
    runState,
    runStateReason,
    entries,
    pending: pendingSend,
    now,
    lastProgressAt,
    agentSeenAt,
    piActiveAt,
    pendingAction,
  });
  const ticking =
    activity.phase === "sending" || activity.phase === "waking" || activity.phase === "working" || activity.phase === "quiet";

  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  // Answered: the pending send has done its job.
  useEffect(() => {
    if (pendingSend && activity.phase === "none" && pendingSend.error === undefined) setPendingSend(null);
  }, [pendingSend, activity.phase]);

  function flashOutcome(outcome: TransportOutcome) {
    setTransportOutcome(outcome);
    setTimeout(() => setTransportOutcome((current) => (current === outcome ? null : current)), OUTCOME_FLASH_MS);
  }

  function loadSession() {
    if (!sessionId) return;
    api
      .session(sessionId)
      .then((s) => {
        setSession(s);
        setNotFound(false);
      })
      .catch((err) => {
        const state = toApiErrorState(err, "Failed to load session");
        if (state.status === 404) setNotFound(true);
        else setApiError(state);
      });
  }

  useEffect(() => {
    loadSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // E3.8: GET /api/models' contextWindow is the only piece deriveSessionHeader can't get from the
  // transcript itself. Fetched once per page visit (ModelsService caches server-side for 5 min
  // regardless), not on every entries change.
  useEffect(() => {
    api.models().then(setModels).catch(() => setModels([]));
  }, []);

  useEffect(() => {
    const title = session?.name ?? (sessionId ? `Floppy ${sessionId.slice(0, 8)}` : "Floppy");
    const previous = document.title;
    document.title = `${title} · Outfitter`;
    return () => {
      document.title = previous;
    };
  }, [session?.name, sessionId]);

  // idle/stopped/failed means pi is not inside a tool. A newer user message settles the
  // previous turn even when the next run is already "running" again.
  const runSettled = runState === "idle" || runState === "stopped" || runState === "failed";
  const beats = groupBeats(groupThinkingBlocks(entriesToViews(entries, { runSettled })), { runSettled });
  // #285. The streamed text is the open message, which is not in the transcript yet, so it
  // wins over a persisted tail from earlier in the turn. Once that message is stored the
  // stream clears; the beat keeps the bubble up while later tool calls from the same turn run.
  const runLive = thoughtBubbles && runState === "running";
  const persistedThought = runLive ? liveThinkingItem(beats, true) : null;
  const showStreamedThought =
    runLive && streamedThought !== null && !(persistedThought && railThinkingText(persistedThought) === streamedThought);
  const liveThoughtText = showStreamedThought ? streamedThought : persistedThought ? railThinkingText(persistedThought) : "";

  // Follow the latest entry. Remember where that jump landed so its scroll event does
  // not tuck the status line away before it has been seen.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || getComputedStyle(el).overflowY === "visible") return;
    if (el.scrollHeight <= el.clientHeight + 16) {
      landedAt.current = null;
      return;
    }
    el.scrollTo({ top: el.scrollHeight });
    landedAt.current = el.scrollTop;
    followThought.current = true;
  }, [entries.length, pendingSend?.localId]);

  // A live thought grows inside one entry, so the entry-count follow above never sees it.
  // Stay with the newest line only when the reader was already at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !liveThoughtText) return;
    if (getComputedStyle(el).overflowY === "visible") return;
    if (!followThought.current) return;
    el.scrollTo({ top: el.scrollHeight });
    landedAt.current = el.scrollTop;
  }, [liveThoughtText]);

  // Phones scroll the page, not the conversation panel, so the same shrink follows window scroll.
  useEffect(() => {
    const onScroll = () => {
      if (!window.matchMedia("(max-width: 700px)").matches) return;
      const top = window.scrollY;
      setCompact((prev) => (top > 16 ? true : top < 4 ? false : prev));
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  async function reload() {
    const fresh = await api.session(sessionId);
    setSession(fresh);
  }

  async function handleSend(text: string, behavior?: "steer" | "followUp") {
    const sentAt = Date.now();
    const localId = `local-${sentAt}`;
    setNow(sentAt);
    setPendingSend({
      localId,
      text,
      behavior,
      sentAt,
      ...nextSendAnchor(entries, pendingSend),
      runStateAtSend: runState,
      sawChange: false,
      sawRunning: false,
    });
    try {
      await api.sendMessage(sessionId, text, behavior);
      const acceptedAt = Date.now();
      setLastProgressAt(acceptedAt);
      setPendingSend((p) => (p?.localId === localId ? { ...p, acceptedAt } : p));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPendingSend((p) => (p?.localId === localId ? { ...p, error: message } : p));
      return;
    }
    await reload().catch(() => {});
  }

  /** Retry on the status line: a failed send or a stuck turn re-sends; a drive that didn't come up
   * is re-woken (and any mail parked for a deploy mismatch released). */
  async function handleRetry() {
    const p = pendingSend;
    if (activity.phase === "wakeTimeout") {
      const at = Date.now();
      setLastProgressAt(at);
      setNow(at);
      if (p) setPendingSend({ ...p, acceptedAt: at, runStateAtSend: runState, sawChange: false, sawRunning: false });
      try {
        await api.retryMail(sessionId);
        if (!p) await api.wake(sessionId);
        await reload();
      } catch (err) {
        setApiError(toApiErrorState(err, "Failed to wake"));
      }
      return;
    }
    if (p) {
      await handleSend(p.text, p.behavior);
      return;
    }
    // A quiet running turn with no send of ours to repeat: keep waiting from now.
    setLastProgressAt(Date.now());
  }

  async function handleMailRetry() {
    try {
      await api.retryMail(sessionId);
      await reload();
    } catch (err) {
      setApiError(toApiErrorState(err, "Failed to retry held messages"));
    }
  }

  async function runAction(action: Exclude<PendingAction, null>, call: () => Promise<unknown>) {
    setPendingAction(action);
    try {
      await withFloppySound(call());
      await reload();
      if (action === "abort") flashOutcome("break");
    } catch (err) {
      if (action === "wake") flashOutcome("loadError");
      setApiError(toApiErrorState(err, `Failed to ${action}`));
    } finally {
      setPendingAction(null);
    }
  }

  async function shelve(action: "archive" | "restore") {
    const id = sessionId;
    setShelving(action);
    try {
      await withFloppySound(action === "archive" ? api.archiveSession(id) : api.restoreSession(id));
      if (currentSessionId.current === id) await reload();
    } catch (err) {
      if (currentSessionId.current === id) setApiError(toApiErrorState(err, `Failed to ${action} floppy`));
    } finally {
      if (currentSessionId.current === id) setShelving(null);
    }
  }

  const handleAbort = () => runAction("abort", () => api.abort(sessionId));
  const handleStop = () => runAction("stop", () => api.stop(sessionId));
  const handleWake = () => runAction("wake", () => api.wake(sessionId));

  async function handleUiResponse(requestId: string, value: unknown) {
    await api.uiResponse(sessionId, requestId, value);
  }

  async function copyTeleport() {
    const cmd = teleportCommand(sessionId);
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard access denied -- nothing more we can do from here
    }
  }

  async function copyGuruId() {
    if (!session?.guruId) return;
    try {
      await navigator.clipboard.writeText(session.guruId);
      setCopiedGuruId(true);
      setTimeout(() => setCopiedGuruId(false), 2000);
    } catch {
      // clipboard access denied -- nothing more we can do from here
    }
  }

  if (notFound) return <NotFoundError subject="This floppy" />;

  const archived = Boolean(session?.archivedAt);

  // #273: only the latest VS Code chip in the conversation is live.
  const lastVsCodeBeat = [...beats].reverse().find((b) => b.kind !== "passthrough" && b.kind !== "user" && beatOpensVsCode(b))?.id;
  const previewAccess = previewAccessByEntry(
    entries,
    session?.htmlPreviewAccessByRun,
    previewAccessFor(session?.allowExternalHtmlResources),
  );
  const cost = costEstimate ?? session?.cost;
  const windowById = new Map(models.map((m) => [m.id, m.contextWindow]));
  const header = deriveSessionHeader(entries, (id) => windowById.get(id));
  const percent = header.context?.percent;
  const oomMessage = typeof percent === "number" ? contextMeterMessage(percent) : null;
  // Bug 7 (docs/reports/cloud-fixes.md): a pi RPC command agentd's run rejected. Also the api's own
  // reason when it refuses the run's agent connection (agentlink.ts's refuse()) or gives up on its
  // sandbox (runs.ts's reconciler) -- for a run that never started, this note is the only thing a
  // person gets, since the one-line statusLine above only has room for the short reason.
  const detailNote = runStateNote(statusDetail);
  // Same source as the pill and buttons: while a send is in flight (or timed out) the composer's
  // status line speaks for the run, so the header must not also say READY. or "stopped · press Play".
  // The composer keeps READY. as its empty prompt. The lamp beside the pill is the human state.
  const statusLine =
    activity.phase === "none"
      ? deriveTransportStatusLine(activity.pillState, transportOutcome, runStateReason)
      : transportOutcome
        ? transportStatusLine(transportOutcome)
        : null;
  const lamp = sessionLamp({
    runState: activity.pillState,
    phase: activity.phase,
    pendingQuestion: pendingUiRequest != null,
    statusLine,
  });
  const statusError = activity.errorHeadline;
  const composerStatus = statusError ? (
    <span className="send-status send-status-error" role="alert">
      <strong>{statusError}</strong>
      <span className="send-status-detail">{activity.label}</span>
      {!archived && (
        <button type="button" className="btn btn-small" onClick={handleRetry}>
          Retry
        </button>
      )}
    </span>
  ) : activity.label ? (
    <Working label={activity.label.replace(/…$/, "")} srOnly={false} className={`send-status send-status-${activity.phase}`} />
  ) : null;

  // A session's current model reads "provider/model" (deriveSessionHeader); if that provider's
  // own Peripherals row reports "down", the run can't reach it -- surface the same
  // ?DEVICE NOT PRESENT ERROR the Peripherals page shows for that row, right where the user is
  // already looking, instead of a confusing generic run failure.
  const floppyTitle = session?.name ?? `Floppy ${sessionId.slice(0, 8)}`;
  const cluster = githubCluster(session);
  const looseRepo = looseRepoClause(session);
  const modelProviderKind = header.model?.split("/")[0];
  const modelProviderDown = modelProviderKind
    ? providers.find((p) => p.kind === modelProviderKind)?.status === "down"
    : false;

  function onSessionScroll(event: UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    const top = el.scrollTop;
    if (landedAt.current !== null && Math.abs(top - landedAt.current) < 2) return;
    landedAt.current = null;
    // Same slop as the jump recorded above. A short scroll up is the reader, and the next
    // thought line must not pull them back to the bottom.
    followThought.current = el.scrollHeight - top - el.clientHeight < 2;
    setCompact((prev) => (top > 16 ? true : top < 4 ? false : prev));
  }

  return (
    // #273: one view of the Drive's IDE for the status-bar chip and any chat chips (the vscode tool).
    <IdeProvider sessionId={sessionId} runState={runState} onError={setApiError}>
    <div className="session-view">
      {apiError && (
        <SystemErrorDialog
          error={apiError}
          onRestart={() => {
            setApiError(null);
            loadSession();
          }}
          onResume={() => setApiError(null)}
        />
      )}
      <div className="panel session-window">
        <div className={`session-chrome${compact ? " is-min" : ""}`}>
          <div className="panel-titlebar session-titlebar">
            <h2 className="panel-label session-window-name" title={floppyTitle}>
              {floppyTitle}
            </h2>
            <span className="session-window-status">
              <TransportDot tone={lamp.tone} label={lamp.detail === lamp.label ? undefined : lamp.label} />
              <StatusPill state={activity.pillState} />
            </span>
            {lamp.detail && (
              <span className={`session-transport-detail${lamp.detail === "BREAK" ? " is-attention" : ""}`} title={lamp.detail}>
                {lamp.detail}
              </span>
            )}
            <div className="run-controls">
              {chromePlace.ready && (
                <>
                  <button
                    type="button"
                    className="btn"
                    title="Open this Floppy in its own tab group"
                    onClick={() => chromePlace.place("own", floppyTitle)}
                  >
                    This Floppy's group
                  </button>
                  <button
                    type="button"
                    className="btn"
                    title="Open this Floppy in the shared Floppies group"
                    onClick={() => chromePlace.place("shared", floppyTitle)}
                  >
                    Floppies group
                  </button>
                  <button
                    type="button"
                    className="btn"
                    title="Open this Floppy in a new window"
                    onClick={() => chromePlace.place("window", floppyTitle)}
                  >
                    New window
                  </button>
                  {chromePlace.split && (
                    <>
                      {splitTargets.length > 0 && (
                        <select aria-label="Floppy to split beside" value={splitTarget} onChange={(event) => setSplitTarget(event.target.value)}>
                          {splitTargets.map((row) => (
                            <option key={row.id} value={row.id}>
                              {row.name ?? `Floppy ${row.id.slice(0, 8)}`}
                            </option>
                          ))}
                        </select>
                      )}
                      <button
                        type="button"
                        className="btn"
                        disabled={!splitTarget}
                        title="Split this Floppy beside another"
                        onClick={() => chromePlace.splitWith(splitTarget)}
                      >
                        Split
                      </button>
                    </>
                  )}
                </>
              )}
              <button className="btn session-transport" onClick={copyTeleport} title={transport.eject.hint}>
                {copied ? "Copied!" : transportLabel("eject")}
              </button>
              {session?.canManage && !archived && (
                <button className="btn session-transport" onClick={() => shelve("archive")} disabled={shelving !== null} title={floppyActions.archive.hint}>
                  {shelving === "archive" ? <Working label="Archiving" /> : floppyActions.archive.word}
                </button>
              )}
              <button
                className="btn btn-danger session-transport"
                onClick={handleAbort}
                disabled={!activity.canAbort}
                title="Interrupt the current turn, like the C64 RUN/STOP key"
              >
                {pendingAction === "abort" ? <Working label="Breaking" /> : transportLabel("abort")}
              </button>
              <button className="btn btn-danger session-transport" onClick={handleStop} disabled={!activity.canStop} title="Stop this floppy's run">
                {pendingAction === "stop" ? <Working label="Stopping" /> : transportLabel("stop")}
              </button>
              <button
                className="btn btn-primary session-transport"
                onClick={handleWake}
                disabled={!activity.canWake || archived}
                title="Wake this floppy and start the run"
              >
                {pendingAction === "wake" ? <Working label="Waking" /> : transportLabel("wake")}
              </button>
            </div>
          </div>
          <div className="session-statusbar">
            <button
              type="button"
              className={`nerd-out-toggle${nerdOut ? " is-open" : ""}`}
              aria-expanded={nerdOut}
              aria-controls={nerdOut ? "nerd-out-panel" : undefined}
              title="Drive details, stats and logs"
              onClick={() => setNerdOutFor(nerdOut ? null : sessionId)}
            >
              Nerd out
            </button>
            <ThoughtBubbleToggle
              on={thoughtBubbles}
              onChange={(next) => {
                setThoughtBubbleEnabled(next);
                setThoughtBubbles(next);
              }}
            />
            {session?.guruId && (
              <span className="session-guru-id">
                <span className="mono" title={session.guruId}>
                  {session.guruId.slice(0, 8)}
                </span>
                <button
                  type="button"
                  className="copy-chip"
                  onClick={copyGuruId}
                  aria-label="Copy full tape id"
                  title="Copy full tape id"
                >
                  {copiedGuruId ? "✓" : "⧉"}
                </button>
              </span>
            )}
            {looseRepo && (
              <span className="session-repo-branch" title={looseRepo}>
                {looseRepo}
              </span>
            )}
            {typeof cost === "number" && <span>${cost.toFixed(4)}</span>}
            {/* The stream's value once a status event has said anything (null included), else the
                session detail's from page load. */}
            <StartupTime
              startup={streamStartup !== undefined ? streamStartup : session?.startup}
              runState={runState}
              collapsed={compact}
            />
            {cluster && <GithubChip cluster={cluster} />}
            <PreviewChips sessionId={sessionId} runState={runState} onError={setApiError} />
            <IdeChip />
            <span className="session-model-info">
              {header.model ? <span className="mono">{header.model}</span> : "model unknown yet"}
              {header.thinking ? <span>thinking {header.thinking}</span> : null}
              {header.context ? (
                <span className="context-usage">
                  {header.context.window
                    ? `${header.context.tokens.toLocaleString()} / ${header.context.window.toLocaleString()} tokens`
                    : `${header.context.tokens.toLocaleString()} tokens`}
                  {typeof percent === "number" && (
                    <span
                      className={`meter context-meter${percent >= 80 ? " meter-danger" : percent >= 50 ? " meter-warn" : ""}`}
                      role="meter"
                      aria-label="Context used"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(percent)}
                    >
                      <span className="meter-fill" style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
                    </span>
                  )}
                </span>
              ) : null}
            </span>
          </div>
          {oomMessage && (
            <p className="context-oom-note" role="alert">
              {oomMessage}
            </p>
          )}
          {modelProviderDown && (
            <DeviceNotPresent reason={`the ${modelProviderKind} peripheral is down -- this run can't reach its model right now.`} />
          )}
          {detailNote && (
            <p className="status-detail-note" role="alert">
              {detailNote}
            </p>
          )}
          {session?.mailNotice && (
            <p className="mail-held-note" role="alert">
              <span>
                {session.mailNotice}
                {session.heldMail ? ` (${session.heldMail})` : ""}
              </span>
              <button
                type="button"
                className="btn btn-small"
                onClick={handleMailRetry}
                disabled={archived}
                title={archived ? "Restore this floppy to deliver its messages" : undefined}
              >
                Retry
              </button>
            </p>
          )}
          {archived && (
            <p className="archived-note" role="status">
              <span>This floppy is archived: it can't run or take messages until it's restored.</span>
              {session?.canManage && (
                <>
                  <button type="button" className="btn btn-small" onClick={() => shelve("restore")} disabled={shelving !== null} title={floppyActions.restore.hint}>
                    {shelving === "restore" ? <Working label="Restoring" /> : floppyActions.restore.word}
                  </button>
                  <button type="button" className="btn btn-small btn-danger" onClick={() => setFormatOpen(true)} disabled={shelving !== null} title={floppyActions.format.hint}>
                    {floppyActions.format.word}…
                  </button>
                </>
              )}
            </p>
          )}
          {chromePlace.note && (
            <p className="status-detail-note" role="alert">
              {chromePlace.note}
            </p>
          )}
        </div>
        {nerdOut && (
          <div id="nerd-out-panel" className="nerd-out-slot">
            <NerdOutPanel
              key={sessionId}
              sessionId={sessionId}
              runState={runState}
              startup={streamStartup !== undefined ? streamStartup : session?.startup}
              onClose={() => setNerdOutFor(null)}
            />
          </div>
        )}
        <div className="session-scroll" ref={scrollRef} onScroll={onSessionScroll}>
        <div className="transcript">
          {beats.length === 0 && !activity.showOptimistic && !showStreamedThought ? (
            <p className="empty-state">No entries yet. Send a message below to start the run.</p>
          ) : (
            // #132/#147: each beat's HTML previews start the way the prompt of the run that wrote
            // it described. The Composer's own Markdown preview is outside these and stays sealed.
            beats.map((beat) => (
              <HtmlPreviewAccessContext.Provider key={beat.id} value={previewAccess(beatEntryId(beat))}>
                {beat.kind === "passthrough" ? (
                  <EntryItem view={beat.view} sessionId={sessionId} />
                ) : (
                  <BeatView
                    beat={beat}
                    defaultThinkingExpanded={defaultThinkingExpanded}
                    vscodeLive={beat.id === lastVsCodeBeat}
                    liveThinkingId={showStreamedThought ? undefined : persistedThought?.id}
                  />
                )}
              </HtmlPreviewAccessContext.Provider>
            ))
          )}
          <StreamedThought text={showStreamedThought ? streamedThought : null} drop={persistedThought !== null} />
          {activity.showOptimistic && pendingSend && (
            <div
              className={`entry user entry-optimistic${pendingSend.error !== undefined ? " entry-failed" : ""}`}
              data-local-id={pendingSend.localId}
            >
              <YouMark />
              {pendingSend.text}
              {pendingSend.acceptedAt === undefined && pendingSend.error === undefined && (
                <span className="entry-sending-note">Sending</span>
              )}
              {pendingSend.error !== undefined && (
                <span className="entry-failed-note" role="alert">
                  Not sent{pendingSend.error ? `: ${pendingSend.error}` : ""}.{" "}
                  <button type="button" className="btn btn-small" onClick={handleRetry}>
                    Retry
                  </button>
                </span>
              )}
            </div>
          )}
        </div>
        </div>
      </div>

      {formatOpen && (
        <FormatFloppyDialog
          sessionId={sessionId}
          title={floppyTitle}
          onCancel={() => setFormatOpen(false)}
          onError={(error) => {
            setFormatOpen(false);
            setApiError(error);
          }}
          onFormatted={() => navigate("/fleet?archived=only")}
        />
      )}

      {pendingUiRequest && <UiRequestPanel request={pendingUiRequest} onRespond={handleUiResponse} />}

      <Composer
        // One composer per session: a draft (and its Preview state) never follows the user to
        // another session, where Enter would send it to the wrong agent.
        key={sessionId}
        sessionId={sessionId}
        voiceEngine={session?.voiceEngine}
        voiceSpeak={session?.voiceSpeak}
        entries={entries}
        entriesLoaded={entriesLoaded}
        agentBusy={ticking}
        onSend={handleSend}
        disabled={activity.composerDisabled || archived}
        sending={activity.phase === "sending"}
        status={composerStatus}
        placeholderOverride={statusLine === "READY." ? "READY." : undefined}
      />
    </div>
    </IdeProvider>
  );
}
