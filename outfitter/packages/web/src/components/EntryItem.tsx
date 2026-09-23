import { useEffect, useState } from "react";
import { api } from "../api/client.ts";
import type { GroupedEntry } from "../lib/thinking.ts";
import { thinkingAccessibleLabel, thinkingPreview, thinkingWordLabel } from "../lib/thinking.ts";
import { BROWSER_CAPTURE_TYPE } from "../lib/entry-view.ts";
import { apiErrorKind, noticeContent, systemErrorContent } from "../lib/retro-errors.ts";
import { toApiErrorState } from "../lib/api-error.ts";
import type { ApiErrorState } from "./SystemErrorDialog.tsx";
import { Markdown } from "./Markdown.tsx";
import { ThinkingIcon } from "./DeskIcons.tsx";

// Minimal, framework-free rendering of one EntryView. @earendil-works/pi-web-ui ships web
// components built on mini-lit against pi-ai's Message shape directly rather than pi's persisted
// SessionEntry tree (parentId-linked, with model_change/compaction/custom/label entries mixed in);
// adapting that -- and bridging its web-component custom elements into React -- was more than this
// story's budget covers, so these are hand-written instead (see docs/reports/web-ui.md).

// Design pass (docs/reports/design-pass.md): tool call/result bodies can be arbitrarily long
// (file diffs, command output). Past this length they render inside a native <details> so the
// transcript stays scannable -- collapsed by default, expandable with a click or Enter/Space,
// with no extra JS needed for the accessibility behavior.
const COLLAPSE_THRESHOLD = 400;

function Collapsible({ text: raw, summary }: { text: string | undefined; summary: string }) {
  // JSON.stringify(undefined) is undefined, and a transcript from an older or foreign writer can
  // omit fields: never let one odd entry blank the whole session page.
  const text = raw ?? "";
  if (text.length <= COLLAPSE_THRESHOLD) return <pre>{text}</pre>;
  return (
    <details>
      <summary>
        {summary} ({text.length.toLocaleString()} chars, click to expand)
      </summary>
      <pre>{text}</pre>
    </details>
  );
}

// Design pass (docs/reports/mobile-desk.md "Thinking..."): thinking blocks are collapsed by
// default -- a run of consecutive assistant-thinking views (see lib/thinking.ts's
// groupThinkingBlocks) renders as one collapsed row: a pixel thought-bubble glyph, "Thinking" (or
// "Thinking ×3" for a group of three), a one-line preview, and a word count. Desktop uses a native
// <details>/<summary> (free disclosure semantics, no extra JS); phones (<=700px, styles/mobile.css)
// collapse further to an icon+count chip that expands the same markdown body in place below it.
// Both are rendered and CSS picks one per breakpoint (the same dual-render pattern Composer.tsx
// and ProviderStrip.tsx already use), sharing one `expanded` boolean so there's no state to lose
// switching viewport width mid-session.
function ThinkingGroup({ blocks, defaultExpanded }: { blocks: { id: string; text: string }[]; defaultExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const combined = blocks.map((b) => b.text).join("\n\n");
  const preview = thinkingPreview(blocks[0]?.text ?? "");
  const label = blocks.length > 1 ? `Thinking ×${blocks.length}` : "Thinking";
  const ariaLabel = thinkingAccessibleLabel(combined, expanded);

  return (
    <div className="entry assistant-thinking-group">
      <details
        className="thinking-details"
        open={expanded}
        onToggle={(e) => setExpanded(e.currentTarget.open)}
      >
        <summary aria-label={ariaLabel}>
          <ThinkingIcon size={14} className="thinking-glyph" />
          <span className="thinking-summary-label">{label}</span>
          {!expanded && preview && <span className="thinking-preview">{preview}</span>}
          <span className="thinking-word-count">{thinkingWordLabel(combined)}</span>
        </summary>
        <div className="thinking-body">
          {blocks.map((b) => (
            <Markdown key={b.id} text={b.text} />
          ))}
        </div>
      </details>

      <button
        type="button"
        className="thinking-chip"
        aria-expanded={expanded}
        aria-label={ariaLabel}
        onClick={() => setExpanded((v) => !v)}
      >
        <ThinkingIcon size={14} className="thinking-glyph" />
        {blocks.length > 1 && <span className="thinking-chip-count">{"×"}{blocks.length}</span>}
      </button>
      {expanded && (
        <div className="thinking-chip-body">
          {blocks.map((b) => (
            <Markdown key={b.id} text={b.text} />
          ))}
        </div>
      )}
    </div>
  );
}

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
        <img
          src={src}
          alt={title || "Browser capture"}
          onError={() => {
            setSrc(null);
            setError((prev) => prev ?? { message: "Failed to load capture" });
          }}
        />
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
      return <ThinkingGroup blocks={view.blocks} defaultExpanded={defaultThinkingExpanded} />;
    case "user":
      return (
        <div className="entry user">
          <div className="entry-label">You</div>
          <Markdown text={view.text} />
        </div>
      );
    case "assistant-text":
      return (
        <div className="entry assistant-text">
          <div className="entry-label">Assistant</div>
          <Markdown text={view.text} />
        </div>
      );
    case "tool-call":
      return (
        <div className="entry tool-call">
          <div className="entry-label">Tool call: {view.toolName}</div>
          <Collapsible text={JSON.stringify(view.input, null, 2)} summary="Input" />
        </div>
      );
    case "tool-result":
      return (
        <div className={`entry tool-result${view.isError ? " error" : ""}`}>
          <div className="entry-label">
            Tool result: {view.toolName}
            {view.isError ? " (error)" : ""}
          </div>
          <Collapsible text={view.text} summary="Output" />
        </div>
      );
    case "system":
      return (
        <div className="entry system">
          <div className="entry-label">System</div>
          <Markdown text={view.text} />
        </div>
      );
    case "model-change":
      return (
        <div className="entry model-change">
          Model changed to {view.provider}/{view.modelId}
        </div>
      );
    case "thinking-level-change":
      return (
        <div className="entry thinking-level-change">
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
      return <div className="entry custom">custom: {view.customType}</div>;
    case "label":
      return <div className="entry label">label: {view.label ?? "(removed)"}</div>;
    case "session-info":
      return <div className="entry session-info">session renamed: {view.name}</div>;
    default:
      return <div className="entry unknown">unrecognized entry: {view.entryType}</div>;
  }
}
