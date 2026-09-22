import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, type ModelRow, type SessionDetail } from "../api/client.ts";
import { useSessionStream } from "../hooks/useSessionStream.ts";
import { useProviders } from "../hooks/useProviders.ts";
import { entriesToViews } from "../lib/entry-view.ts";
import { groupThinkingBlocks } from "../lib/thinking.ts";
import { deriveSessionHeader } from "../lib/session-header.ts";
import { contextMeterMessage, deriveTransportStatusLine, transportStatusLine, type TransportOutcome } from "../lib/retro-errors.ts";
import { toApiErrorState } from "../lib/api-error.ts";
import { EntryItem } from "../components/EntryItem.tsx";
import { Composer } from "../components/Composer.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import { UiRequestPanel } from "../components/UiRequestPanel.tsx";
import { Working } from "../components/Working.tsx";
import { NotFoundError } from "../components/NotFoundError.tsx";
import { SystemErrorDialog, type ApiErrorState } from "../components/SystemErrorDialog.tsx";
import { DeviceNotPresent } from "../components/DeviceNotPresent.tsx";
import { withFloppySound } from "../lib/floppy-sound.ts";
import { transport, transportLabel } from "../lib/vocabulary.ts";
import { deriveSessionActivity, nextSendAnchor, notePendingRunState, type PendingSend } from "../lib/send-status.ts";

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
  const { entries, runState, runStateReason, statusDetail, pendingUiRequest, costEstimate } = useSessionStream(sessionId);
  const { providers } = useProviders();
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  // Cloud-fixes 11: the message just sent, until its stored entry and reply arrive.
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null);
  // Last time the page saw progress (a new entry or run state change) -- the work/wake timeouts
  // count from here. `now` ticks while something is in flight so a timeout can fire.
  const [lastProgressAt, setLastProgressAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  // The route reuses this component when navigating from one session to another (App.tsx's
  // /sessions/:id has no key), so a pending send must not follow the user into the next session:
  // its baseline indexes the old session's entries and its optimistic row would show there.
  useEffect(() => {
    setPendingSend(null);
    setLastProgressAt(Date.now());
  }, [sessionId]);

  useEffect(() => {
    setLastProgressAt(Date.now());
  }, [entries.length]);

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
    pendingAction,
  });
  const ticking = activity.phase === "sending" || activity.phase === "waking" || activity.phase === "working";

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
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [entries.length, pendingSend?.localId]);

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

  const handleAbort = () => runAction("abort", () => api.abort(sessionId));
  const handleStop = () => runAction("stop", () => api.stop(sessionId));
  const handleWake = () => runAction("wake", () => api.wake(sessionId));

  async function handleUiResponse(requestId: string, value: unknown) {
    await api.uiResponse(sessionId, requestId, value);
  }

  async function copyTeleport() {
    const cmd = `kernal --teleport ${sessionId}`;
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

  const views = groupThinkingBlocks(entriesToViews(entries));
  const cost = costEstimate ?? session?.cost;
  const windowById = new Map(models.map((m) => [m.id, m.contextWindow]));
  const header = deriveSessionHeader(entries, (id) => windowById.get(id));
  const percent = header.context?.percent;
  const oomMessage = typeof percent === "number" ? contextMeterMessage(percent) : null;
  // Same source as the pill and buttons: while a send is in flight (or timed out) the composer's
  // status line speaks for the run, so the header must not also say READY. or "stopped · press Play".
  const statusLine =
    activity.phase === "none"
      ? deriveTransportStatusLine(activity.pillState, transportOutcome, runStateReason)
      : transportOutcome
        ? transportStatusLine(transportOutcome)
        : null;
  const statusError = activity.errorHeadline;
  const composerStatus = statusError ? (
    <span className="send-status send-status-error" role="alert">
      <strong>{statusError}</strong>
      <span className="send-status-detail">{activity.label}</span>
      <button type="button" className="btn btn-small" onClick={handleRetry}>
        Retry
      </button>
    </span>
  ) : activity.label ? (
    <Working label={activity.label.replace(/…$/, "")} srOnly={false} className={`send-status send-status-${activity.phase}`} />
  ) : null;

  // A session's current model reads "provider/model" (deriveSessionHeader); if that provider's
  // own Peripherals row reports "down", the run can't reach it -- surface the same
  // ?DEVICE NOT PRESENT ERROR the Peripherals page shows for that row, right where the user is
  // already looking, instead of a confusing generic run failure.
  const modelProviderKind = header.model?.split("/")[0];
  const modelProviderDown = modelProviderKind
    ? providers.find((p) => p.kind === modelProviderKind)?.status === "down"
    : false;

  return (
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
      <div className="session-header">
        <div>
          <h2 className="session-title" title={sessionId}>
            {session?.name ?? `Floppy ${sessionId?.slice(0, 8) ?? ""}`}
          </h2>
          <div className="session-meta session-subline">
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
            <span className="session-repo-branch" title={session?.repo ? `${session.repo}${session.branch ? ` @ ${session.branch}` : ""}` : undefined}>
              {session?.repo ? `· ${session.repo}${session.branch ? ` @ ${session.branch}` : ""}` : "· no repository"}
            </span>
            {typeof cost === "number" ? ` · $${cost.toFixed(4)}` : ""}
          </div>
          <div className="session-meta session-model-info">
            {header.model ? <span className="mono">{header.model}</span> : "model unknown yet"}
            {header.thinking ? ` · thinking ${header.thinking}` : ""}
            {header.context ? (
              <span className="context-usage">
                {" · "}
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
            {statusLine && (
              <span className={`transport-status-line${statusLine === "READY." ? " ready" : ""}`}>
                {" · "}
                {statusLine}
                {statusLine === "READY." && <span className="cursor-blink" aria-hidden="true" />}
              </span>
            )}
          </div>
          {oomMessage && (
            <p className="context-oom-note" role="alert">
              {oomMessage}
            </p>
          )}
          {modelProviderDown && (
            <DeviceNotPresent reason={`the ${modelProviderKind} peripheral is down -- this run can't reach its model right now.`} />
          )}
          {/* Bug 7 (docs/reports/cloud-fixes.md): a rejected pi RPC (prompt/steer/follow_up) used to
           * vanish silently; agentd now surfaces it via the run's status detail. */}
          {statusDetail && (
            <p className="status-detail-note" role="alert">
              {statusDetail}
            </p>
          )}
          {session?.mailNotice && (
            <p className="mail-held-note" role="alert">
              <span>
                {session.mailNotice}
                {session.heldMail ? ` (${session.heldMail})` : ""}
              </span>
              <button type="button" className="btn btn-small" onClick={handleMailRetry}>
                Retry
              </button>
            </p>
          )}
        </div>
        <div className="run-controls">
          <StatusPill state={activity.pillState} />
          <button className="btn" onClick={copyTeleport} title={transport.eject.hint}>
            {copied ? "Copied!" : transportLabel("eject")}
          </button>
          <button
            className="btn btn-danger"
            onClick={handleAbort}
            disabled={!activity.canAbort}
            title="Interrupt the current turn, like the C64 RUN/STOP key"
          >
            {pendingAction === "abort" ? <Working label="Breaking" /> : transportLabel("abort")}
          </button>
          <button className="btn btn-danger" onClick={handleStop} disabled={!activity.canStop} title="Stop this floppy's run">
            {pendingAction === "stop" ? <Working label="Stopping" /> : transportLabel("stop")}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleWake}
            disabled={!activity.canWake}
            title="Wake this floppy and start the run"
          >
            {pendingAction === "wake" ? <Working label="Waking" /> : transportLabel("wake")}
          </button>
        </div>
      </div>

      {pendingUiRequest && <UiRequestPanel request={pendingUiRequest} onRespond={handleUiResponse} />}

      <div className="panel">
        <div className="panel-titlebar"><span className="panel-label">Transcript</span></div>
        <div className="transcript" ref={transcriptRef}>
          {views.length === 0 && !activity.showOptimistic ? (
            <p className="empty-state">No entries yet. Send a message below to start the run.</p>
          ) : (
            views.map((v) => <EntryItem key={v.id} view={v} defaultThinkingExpanded={defaultThinkingExpanded} />)
          )}
          {activity.showOptimistic && pendingSend && (
            <div
              className={`entry user entry-optimistic${pendingSend.error !== undefined ? " entry-failed" : ""}`}
              data-local-id={pendingSend.localId}
            >
              <div className="entry-label">You{pendingSend.acceptedAt === undefined && pendingSend.error === undefined ? " · sending" : ""}</div>
              {pendingSend.text}
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

      <Composer
        onSend={handleSend}
        disabled={activity.composerDisabled}
        sending={activity.phase === "sending"}
        status={composerStatus}
        placeholderOverride={statusLine === "READY." ? "READY." : undefined}
      />
    </div>
  );
}
