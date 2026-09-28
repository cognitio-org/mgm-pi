import { useEffect, useState } from "react";
import { api } from "../api/client.ts";
import type { GroupedEntry } from "../lib/thinking.ts";
import { groupBeats } from "../lib/beats.ts";
import { BROWSER_CAPTURE_TYPE, PLAYWRIGHT_CHECK_TYPE, failedAttemptCopy } from "../lib/entry-view.ts";
import { apiErrorKind, noticeContent, systemErrorContent } from "../lib/retro-errors.ts";
import { toApiErrorState } from "../lib/api-error.ts";
import type { ApiErrorState } from "./SystemErrorDialog.tsx";
import { Markdown } from "./Markdown.tsx";
import { BeatView } from "./TranscriptRail.tsx";
import { ImageViewer } from "./ImageViewer.tsx";

// Passthrough rows (system, compaction, browser captures, …) stay full-width lines.
// User, assistant, thinking, and tool views are one beat: see lib/beats.ts and TranscriptRail.tsx.

function captureErrorCopy(error: ApiErrorState): { headline: string; message: string } {
  const kind = apiErrorKind(error.status);
  return kind === "system" ? systemErrorContent(error.message) : noticeContent(kind, error.message);
}

// An <img src> would send same-origin cookies but not the dev bearer. Fetch the jpeg the same
// way as every other API call, then show the bytes, so a failed load never leaves a broken image.
function BrowserCapture({
  sessionId,
  captureId,
  title,
  url,
}: {
  sessionId: string;
  captureId: string;
  title: string;
  url: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<ApiErrorState | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!sessionId || !captureId) {
      setSrc(null);
      setError({ message: "Failed to load capture" });
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    setSrc(null);
    setError(null);
    api
      .browserCapture(sessionId, captureId)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(toApiErrorState(err, "Failed to load capture"));
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sessionId, captureId]);

  const failure = error ? captureErrorCopy(error) : null;
  return (
    <div className="entry custom">
      {src && !error ? (
        <button type="button" className="user-attachment" onClick={() => setOpen(true)}>
          <img
            src={src}
            alt={title || "Browser capture"}
            onError={() => {
              setSrc(null);
              setError((prev) => prev ?? { message: "Failed to load capture" });
            }}
          />
        </button>
      ) : null}
      {open && src ? (
        <ImageViewer src={src} alt={title || "Browser capture"} filename="capture.jpg" onClose={() => setOpen(false)} />
      ) : null}
      {failure ? (
        <span className="entry-failed-note">
          {failure.headline}
          {failure.message ? ` — ${failure.message}` : ""}
        </span>
      ) : null}
      <div>{title}</div>
      <div>{url}</div>
    </div>
  );
}

export function EntryItem({
  view,
  sessionId,
  defaultThinkingExpanded,
}: {
  view: GroupedEntry;
  sessionId?: string;
  defaultThinkingExpanded?: boolean;
}) {
  switch (view.kind) {
    case "thinking-group":
    case "user":
    case "assistant-text":
    case "tool-call":
    case "tool-result": {
      const beat = groupBeats([view])[0];
      return beat && beat.kind !== "passthrough" ? (
        <BeatView beat={beat} defaultThinkingExpanded={defaultThinkingExpanded} />
      ) : null;
    }
    case "system":
      return (
        <div className="entry system boot-line">
          <div className="boot-tag">System</div>
          {view.text.trim() ? <Markdown text={view.text} /> : null}
        </div>
      );
    case "model-change":
      return (
        <div className="entry model-change boot-line">
          Model changed to {view.provider}/{view.modelId}
        </div>
      );
    case "thinking-level-change":
      return (
        <div className="entry thinking-level-change boot-line">
          Thinking level changed to {view.thinkingLevel}
        </div>
      );
    case "compaction":
      return (
        <div className="entry compaction">
          <div className="entry-label">Compacted</div>
          <Markdown text={view.summary} />
        </div>
      );
    case "assistant-failed": {
      const copy = failedAttemptCopy(view);
      return (
        <div className="entry assistant-failed" role="status">
          <div className="entry-label">{copy.headline}</div>
          <div>{copy.note}</div>
          {view.errorMessage ? (
            <details>
              <summary>Error</summary>
              <pre>{view.errorMessage}</pre>
            </details>
          ) : null}
        </div>
      );
    }
    case "context-edit":
      return (
        <div className="entry context-edit">
          {view.replaced ? "An earlier message was replaced in the model's context" : "An earlier message was hidden from the model"}
        </div>
      );
    case "custom":
      if (view.customType === BROWSER_CAPTURE_TYPE) {
        return (
          <BrowserCapture
            sessionId={sessionId ?? ""}
            captureId={view.captureId ?? ""}
            title={view.title ?? ""}
            url={view.url ?? ""}
          />
        );
      }
      if (view.customType === PLAYWRIGHT_CHECK_TYPE) {
        return (
          <div className="entry custom">
            <div className="entry-label">Playwright</div>
            <pre>{view.text ?? ""}</pre>
          </div>
        );
      }
      return <div className="entry custom">custom: {view.customType}</div>;
    case "label":
      return <div className="entry label">label: {view.label ?? "(removed)"}</div>;
    case "session-info":
      return <div className="entry session-info">session renamed: {view.name}</div>;
    default:
      return <div className="entry unknown">unrecognized entry: {view.entryType}</div>;
  }
}
