import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, type PreviewRow, type PreviewsState } from "../api/client.ts";
import { toApiErrorState } from "../lib/api-error.ts";
import { Working } from "./Working.tsx";
import type { ApiErrorState } from "./SystemErrorDialog.tsx";

/** How often the chips re-read the session's previews while its Drive runs (the model opens and
 * closes them as jobs start and end). */
export const PREVIEWS_REFRESH_MS = 15_000;

const LIVE = new Set(["queued", "provisioning", "running", "idle", "stopping"]);

const TTL_CHOICES = [
  { seconds: 3600, label: "1 hour" },
  { seconds: 24 * 3600, label: "24 hours" },
  { seconds: 7 * 24 * 3600, label: "7 days" },
];

export function untilLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `until ${time}` : `until ${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

interface Props {
  sessionId: string;
  runState: string | null | undefined;
  onError: (error: ApiErrorState) => void;
}

/**
 * #217 phase 3: the session's Drive previews, next to the other session facts. Each previewed port
 * is a chip that opens it (private: people with access to this session, after Google sign-in).
 * The floppy's owner (or a sysop) can make a public, time-limited link for a port, the only way one
 * is ever made, and stop it again. Nothing renders while there are no previews.
 */
export function PreviewChips({ sessionId, runState, onError }: Props) {
  const [state, setState] = useState<PreviewsState | null>(null);
  const [sharing, setSharing] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const live = Boolean(runState && LIVE.has(runState));

  const load = useCallback(async () => {
    try {
      setState(await api.previews(sessionId));
    } catch {
      // A chip is a convenience: a failed poll keeps the last state and tries again later.
    }
  }, [sessionId]);

  useEffect(() => {
    if (!live) {
      setState((s) => (s ? { ...s, previews: [] } : s));
      return;
    }
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, PREVIEWS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [live, load]);

  if (!state?.enabled || state.previews.length === 0) return null;

  const ports = [...new Set(state.previews.map((p) => p.port))];

  async function stop(p: PreviewRow) {
    setBusy(p.id);
    try {
      await api.closePreview(sessionId, p.id);
      await load();
    } catch (err) {
      onError(toApiErrorState(err, "Couldn't stop the link"));
    } finally {
      setBusy(null);
    }
  }

  async function copy(p: PreviewRow) {
    try {
      await navigator.clipboard.writeText(p.url);
      setCopied(p.id);
      setTimeout(() => setCopied((c) => (c === p.id ? null : c)), 1500);
    } catch {
      /* clipboard refused: the link is still visible */
    }
  }

  return (
    <>
      {ports.map((port) => {
        const priv = state.previews.find((p) => p.port === port && !p.share);
        const pub = state.previews.find((p) => p.port === port && p.share);
        return (
          <span className="preview-cluster" key={port}>
            {priv && (
              <a
                className="preview-chip"
                href={priv.url}
                target="_blank"
                rel="noopener noreferrer"
                title={`Open the app on port ${port}. Anyone with access to this session can open it; they sign in with Google.`}
              >
                <span aria-hidden="true">↗</span> Preview :{port}
              </a>
            )}
            {pub && (
              <span className="preview-chip preview-chip-public" title={`Public link: anyone with it can open the app, ${untilLabel(pub.expiresAt ?? pub.createdAt)}.`}>
                Public link · {pub.expiresAt ? untilLabel(pub.expiresAt) : "open"}
                <button type="button" className="chip-btn" onClick={() => copy(pub)} aria-label="Copy the public link">
                  {copied === pub.id ? "✓" : "⧉"}
                </button>
                {state.canShare && (
                  <button type="button" className="chip-btn" onClick={() => stop(pub)} disabled={busy === pub.id} aria-label="Stop the public link">
                    {busy === pub.id ? <Working label="Stopping" /> : "Stop"}
                  </button>
                )}
              </span>
            )}
            {state.canShare && priv && !pub && (
              <button type="button" className="chip-btn preview-share-btn" onClick={() => setSharing(port)}>
                Share…
              </button>
            )}
          </span>
        );
      })}
      {sharing !== null && (
        <ShareLinkDialog
          sessionId={sessionId}
          port={sharing}
          maxSeconds={state.shareMaxSeconds}
          defaultSeconds={state.shareDefaultSeconds}
          onCancel={() => setSharing(null)}
          onShared={async () => {
            setSharing(null);
            await load();
          }}
          onError={(e) => {
            setSharing(null);
            onError(e);
          }}
        />
      )}
    </>
  );
}

interface DialogProps {
  sessionId: string;
  port: number;
  maxSeconds: number;
  defaultSeconds: number;
  onShared: () => void;
  onCancel: () => void;
  onError: (error: ApiErrorState) => void;
}

/** The one confirm before a Drive's app goes public. Cancel has focus, like FormatFloppyDialog. */
export function ShareLinkDialog({ sessionId, port, maxSeconds, defaultSeconds, onShared, onCancel, onError }: DialogProps) {
  const choices = TTL_CHOICES.filter((c) => c.seconds <= maxSeconds);
  const initial = choices.find((c) => c.seconds === defaultSeconds)?.seconds ?? choices[0]?.seconds ?? maxSeconds;
  const [ttl, setTtl] = useState(initial);
  const [working, setWorking] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && !working) {
      e.preventDefault();
      onCancel();
    }
  }

  async function confirm() {
    setWorking(true);
    try {
      await api.sharePreview(sessionId, port, ttl);
      onShared();
    } catch (err) {
      setWorking(false);
      onError(toApiErrorState(err, "Couldn't make the link"));
    }
  }

  return (
    <div className="dialog-backdrop" onClick={working ? undefined : onCancel}>
      <div
        className="dialog panel notice-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="share-preview-title"
        aria-describedby="share-preview-body"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        ref={ref}
      >
        <div className="panel-titlebar">
          <span className="panel-label" id="share-preview-title">
            Make a public link to port {port}?
          </span>
        </div>
        <div className="panel-body">
          <p id="share-preview-body">
            Anyone with the link can open the app the agent is running, without signing in, until it expires or the
            Drive stops. Visitors first see a page saying it's an AI-built preview. Only share it with people you'd
            show the work to, and don't put secrets in the app.
          </p>
          <label className="form-row">
            <span>Expires after</span>
            <select value={ttl} onChange={(e) => setTtl(Number(e.target.value))} disabled={working}>
              {choices.map((c) => (
                <option key={c.seconds} value={c.seconds}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" onClick={confirm} disabled={working}>
              {working ? <Working label="Making the link" /> : "Make public link"}
            </button>
            <button type="button" className="btn" onClick={onCancel} disabled={working} autoFocus>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
