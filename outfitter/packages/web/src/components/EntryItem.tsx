import type { EntryView } from "../lib/entry-view.ts";
import { Markdown } from "./Markdown.tsx";

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

export function EntryItem({ view }: { view: EntryView }) {
  switch (view.kind) {
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
    case "assistant-thinking":
      return (
        <div className="entry assistant-thinking">
          <div className="entry-label">Thinking</div>
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
    case "compaction":
      return (
        <div className="entry compaction">
          <div className="entry-label">Compacted</div>
          <Markdown text={view.summary} />
        </div>
      );
    case "custom":
      return <div className="entry custom">custom: {view.customType}</div>;
    case "label":
      return <div className="entry label">label: {view.label ?? "(removed)"}</div>;
    case "session-info":
      return <div className="entry session-info">session renamed: {view.name}</div>;
    default:
      return <div className="entry unknown">unrecognized entry: {view.entryType}</div>;
  }
}
