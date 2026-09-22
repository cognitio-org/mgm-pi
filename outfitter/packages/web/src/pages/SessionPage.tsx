import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, ApiError, type ModelRow, type SessionDetail } from "../api/client.ts";
import { useSessionStream } from "../hooks/useSessionStream.ts";
import { entriesToViews } from "../lib/entry-view.ts";
import { deriveSessionHeader } from "../lib/session-header.ts";
import { EntryItem } from "../components/EntryItem.tsx";
import { Composer } from "../components/Composer.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import { UiRequestPanel } from "../components/UiRequestPanel.tsx";
import { Working } from "../components/Working.tsx";
import { withFloppySound } from "../lib/floppy-sound.ts";
import { transportLabel } from "../lib/vocabulary.ts";

const RUNNING_STATES = new Set(["running", "idle", "stopping", "queued", "provisioning"]);
// Subset of RUNNING_STATES that reads as "the agent is actively doing something right now" for
// the transcript's typing indicator -- "idle" (waiting on the user) and "stopping" don't count.
const WORKING_STATES = new Set(["running", "queued", "provisioning"]);

type PendingAction = "abort" | "stop" | "wake" | null;

export function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const sessionId = id ?? "";
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const { entries, runState, pendingUiRequest, costEstimate } = useSessionStream(sessionId);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    api
      .session(sessionId)
      .then(setSession)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load session"));
  }, [sessionId]);

  // E3.8: GET /api/models' contextWindow is the only piece deriveSessionHeader can't get from the
  // transcript itself. Fetched once per page visit (ModelsService caches server-side for 5 min
  // regardless), not on every entries change.
  useEffect(() => {
    api.models().then(setModels).catch(() => setModels([]));
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [entries.length]);

  async function reload() {
    const fresh = await api.session(sessionId);
    setSession(fresh);
  }

  async function handleSend(text: string, behavior?: "steer" | "followUp") {
    await api.sendMessage(sessionId, text, behavior);
    await reload();
  }

  async function runAction(action: Exclude<PendingAction, null>, call: () => Promise<unknown>) {
    setPendingAction(action);
    try {
      await withFloppySound(call());
      await reload();
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
    const cmd = `mgm --teleport ${sessionId}`;
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard access denied -- nothing more we can do from here
    }
  }

  const views = entriesToViews(entries);
  const active = runState ? RUNNING_STATES.has(runState) : false;
  const canWake = !active;
  const cost = costEstimate ?? session?.cost;
  const windowById = new Map(models.map((m) => [m.id, m.contextWindow]));
  const header = deriveSessionHeader(entries, (id) => windowById.get(id));
  const percent = header.context?.percent;

  return (
    <div className="session-view">
      {error && <div className="error-banner">{error}</div>}
      <div className="session-header">
        <div>
          <h2 className="session-title" title={sessionId}>
            {session?.name ?? `Floppy ${sessionId?.slice(0, 8) ?? ""}`}
          </h2>
          <div className="session-meta">
            {session?.guruId} {session?.repo ? `· ${session.repo}${session.branch ? ` @ ${session.branch}` : ""}` : "· no repository"}
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
          </div>
        </div>
        <div className="run-controls">
          <StatusPill state={runState} />
          <button className="btn" onClick={copyTeleport} title="Continue this floppy on your laptop with mgm">
            {copied ? "Copied!" : transportLabel("eject")}
          </button>
          <button
            className="btn btn-danger"
            onClick={handleAbort}
            disabled={!active || pendingAction !== null}
            title="Interrupt the current turn, like the C64 RUN/STOP key"
          >
            {pendingAction === "abort" ? <Working label="Breaking" /> : transportLabel("abort")}
          </button>
          <button className="btn btn-danger" onClick={handleStop} disabled={!active || pendingAction !== null} title="Stop this floppy's run">
            {pendingAction === "stop" ? <Working label="Stopping" /> : transportLabel("stop")}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleWake}
            disabled={!canWake || pendingAction !== null}
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
          {views.length === 0 ? (
            <p className="empty-state">No entries yet. Send a message below to start the run.</p>
          ) : (
            views.map((v) => <EntryItem key={v.id} view={v} />)
          )}
          {runState && WORKING_STATES.has(runState) && (
            <Working label="Guru is working" size="lg" className="transcript-working" />
          )}
        </div>
      </div>

      <Composer onSend={handleSend} />
    </div>
  );
}
