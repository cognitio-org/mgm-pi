import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, ApiError, type SessionDetail } from "../api/client.ts";
import { useSessionStream } from "../hooks/useSessionStream.ts";
import { entriesToViews } from "../lib/entry-view.ts";
import { EntryItem } from "../components/EntryItem.tsx";
import { Composer } from "../components/Composer.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import { UiRequestPanel } from "../components/UiRequestPanel.tsx";

const RUNNING_STATES = new Set(["running", "idle", "stopping", "queued", "provisioning"]);

export function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const sessionId = id ?? "";
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { entries, runState, pendingUiRequest, costEstimate } = useSessionStream(sessionId);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    api
      .session(sessionId)
      .then(setSession)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load session"));
  }, [sessionId]);

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

  async function handleAbort() {
    await api.abort(sessionId);
    await reload();
  }

  async function handleStop() {
    await api.stop(sessionId);
    await reload();
  }

  async function handleWake() {
    await api.wake(sessionId);
    await reload();
  }

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

  return (
    <div className="session-view">
      {error && <div className="error-banner">{error}</div>}
      <div className="session-header">
        <div>
          <h2 style={{ margin: 0 }}>{session?.name ?? sessionId}</h2>
          <div className="session-meta">
            {session?.guruId} {session?.repo ? `· ${session.repo}${session.branch ? ` @ ${session.branch}` : ""}` : "· no repository"}
            {typeof cost === "number" ? ` · $${cost.toFixed(4)}` : ""}
          </div>
        </div>
        <div className="run-controls">
          <StatusPill state={runState} />
          <button onClick={copyTeleport}>{copied ? "Copied!" : "Open in terminal"}</button>
          <button onClick={handleAbort} disabled={!active}>
            Abort
          </button>
          <button onClick={handleStop} disabled={!active}>
            Stop
          </button>
          <button onClick={handleWake} disabled={!canWake}>
            Wake
          </button>
        </div>
      </div>

      {pendingUiRequest && <UiRequestPanel request={pendingUiRequest} onRespond={handleUiResponse} />}

      <div className="transcript" ref={transcriptRef}>
        {views.length === 0 ? (
          <p className="empty-state">No entries yet.</p>
        ) : (
          views.map((v) => <EntryItem key={v.id} view={v} />)
        )}
      </div>

      <Composer onSend={handleSend} />
    </div>
  );
}
