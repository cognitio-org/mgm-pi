import { memo, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { entryIdOf, type FlowItem, type FlowTool } from "../lib/flow.ts";
import type { ThinkingBlock } from "../lib/thinking.ts";
import { thinkingWordLabel } from "../lib/thinking.ts";
import { lookupLabel, toolArgument, toolDiff, toolKind, toolSummary, type ToolDiff } from "../lib/tool-rows.ts";
import { HtmlPreviewAccessContext } from "../lib/html-preview-access.ts";
import type { PreviewAccess } from "../lib/html-preview.ts";
import { EntryItem } from "./EntryItem.tsx";
import { Markdown } from "./Markdown.tsx";
import { UserAttachments } from "./UserAttachments.tsx";
import { VsCodeCard } from "./VsCodeCard.tsx";

// #498: the transcript as one flowing column, Claude Code style, in Outfitter's own dress
// (docs/design/sessions-redesign-demo.html notes 4-6). No boxes round messages and no title bar:
// your messages are inset blocks on the right, the assistant's prose runs under a small square
// bullet, and each tool call is one row you can open. lib/flow.ts decides what the items are.

/** pi's tools are lower-case words (bash, read); shown capitalised like a command name. */
function displayName(toolName: string): string {
  return /^[a-z]+$/.test(toolName) ? toolName.charAt(0).toUpperCase() + toolName.slice(1) : toolName;
}

function formatInput(input: unknown): string {
  if (input === undefined) return "";
  try {
    return JSON.stringify(input, null, 2) ?? "";
  } catch {
    return String(input);
  }
}

export function UserBlock({ id, text, images, queued, children }: { id?: string; text: string; images?: { mimeType: string; data: string }[]; queued?: boolean; children?: ReactNode }) {
  return (
    <div className={`flow-user${queued ? " is-queued" : ""}`} data-entry-id={id}>
      <span className="sr-only">You: </span>
      {queued ? <span className="flow-user-tag">Queued · sends after this turn</span> : null}
      <Markdown text={text} />
      {images && images.length > 0 ? <UserAttachments images={images} /> : null}
      {children}
    </div>
  );
}

const Prose = memo(function Prose({ text }: { text: string }) {
  return (
    <div className="flow-ai">
      <span className="flow-bullet" aria-hidden="true" />
      <div className="flow-prose">
        <span className="sr-only">Assistant: </span>
        <Markdown text={text} />
      </div>
    </div>
  );
});

function thoughtText(blocks: ThinkingBlock[]): string {
  return blocks.map((block) => block.text).join("\n\n");
}

/** A thought, folded to one line. While it's still being written (and the thought-bubble
 * preference is on) it stays open and follows the newest words, unless the reader scrolled up. */
export function ThinkingRow({
  blocks,
  seconds,
  live = false,
  defaultOpen = false,
}: {
  blocks: ThinkingBlock[];
  seconds?: number;
  live?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const text = thoughtText(blocks);
  const shown = open || live;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || !live || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text, live]);
  const label = live ? "Thinking…" : seconds !== undefined ? `Thought for ${seconds}s` : `Thought · ${thinkingWordLabel(text)}`;
  return (
    <div className={`flow-think${live ? " is-live" : ""}`} data-thinking-id={blocks[0]?.id}>
      <button type="button" className="flow-think-line" aria-expanded={shown} onClick={() => setOpen((o) => !o)} disabled={live}>
        <span className="flow-think-star" aria-hidden="true">
          ✻
        </span>
        {label}
        {!live ? (
          <span className="flow-caret" aria-hidden="true">
            ›
          </span>
        ) : null}
      </button>
      {shown ? (
        <div
          className="flow-think-body"
          ref={bodyRef}
          role={live ? "region" : undefined}
          aria-label={live ? "Thinking" : undefined}
          onScroll={(event) => {
            const el = event.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 2;
          }}
        >
          {text.trim() ? text : "…"}
        </div>
      ) : null}
    </div>
  );
}

function DiffBlock({ diff }: { diff: ToolDiff }) {
  return (
    <div className="flow-diff">
      <div className="flow-diff-file">
        <span>{diff.path}</span>
        <span>
          <span className="flow-diff-add">+{diff.add}</span> <span className="flow-diff-del">−{diff.del}</span>
        </span>
      </div>
      <pre>
        {diff.hunks.map((hunk, h) => (
          <span key={h} className="flow-diff-hunk">
            {hunk.map((line, i) => (
              <span key={i} className={`flow-dl${line.op === "same" ? "" : ` is-${line.op}`}`}>
                <span className="flow-dl-mark" aria-label={line.op === "add" ? "added" : line.op === "del" ? "removed" : undefined}>
                  {line.op === "add" ? "+" : line.op === "del" ? "−" : " "}
                </span>
                {line.text}
                {"\n"}
              </span>
            ))}
          </span>
        ))}
      </pre>
    </div>
  );
}

type ToolRowProps = { tool: FlowTool; vscodeLive?: boolean };

/** buildFlow makes new item objects whenever an entry lands, but a row's own fields (and its
 * arguments, which are the stored entry's own object) stay the same. */
export function sameToolRow(a: ToolRowProps, b: ToolRowProps): boolean {
  const x = a.tool;
  const y = b.tool;
  return (
    a.vscodeLive === b.vscodeLive &&
    x.id === y.id &&
    x.toolName === y.toolName &&
    x.input === y.input &&
    x.output === y.output &&
    x.isError === y.isError &&
    x.running === y.running &&
    x.interrupted === y.interrupted
  );
}

/** Memoised: a running turn re-renders the page every second, and a long transcript's rows (and
 * their diffs) must not be rebuilt each time. */
export const ToolRow = memo(function ToolRow({ tool, vscodeLive }: ToolRowProps) {
  const [open, setOpen] = useState(false);
  const kind = toolKind(tool.toolName);
  const diff = useMemo(() => (tool.interrupted ? null : toolDiff(tool.toolName, tool.input)), [tool.interrupted, tool.toolName, tool.input]);
  const summary = toolSummary(tool, diff);
  const arg = toolArgument(tool.toolName, tool.input);
  const state = tool.running ? "is-running" : tool.isError || tool.interrupted ? "is-error" : "is-ok";
  // Everything a row folds away: what came back, and for a tool whose argument line is only a hint,
  // what it was called with.
  const hasOutput = !tool.running && !tool.interrupted && (tool.output ?? "").length > 0;
  const showInput = kind === "other" && tool.input !== undefined;
  const expandable = hasOutput || showInput;
  const opensVsCode = tool.toolName === "vscode" && !tool.isError && !tool.interrupted && !tool.running;
  return (
    <div className={`flow-tool ${state}${open ? " is-open" : ""}`}>
      <span className="flow-tool-dot" aria-hidden="true" />
      <button
        type="button"
        className="flow-tool-line"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen((o) => !o)}
        title={arg || undefined}
      >
        <span className="flow-tool-name">{displayName(tool.toolName)}</span>
        {arg ? <span className="flow-tool-arg">{arg}</span> : null}
        {expandable ? (
          <span className="flow-caret" aria-hidden="true">
            ›
          </span>
        ) : null}
        {tool.running ? <span className="sr-only">, running</span> : null}
      </button>
      <div className={`flow-tool-sum is-${summary.tone}`}>{summary.text}</div>
      {diff && (diff.add > 0 || diff.del > 0) ? <DiffBlock diff={diff} /> : null}
      {open && showInput ? <pre className="flow-tool-out is-input">{formatInput(tool.input)}</pre> : null}
      {open && hasOutput ? <pre className={`flow-tool-out${tool.isError ? " is-error" : ""}`}>{tool.output}</pre> : null}
      {opensVsCode ? (
        <div className="flow-tool-extra">
          <VsCodeCard live={vscodeLive ?? true} />
        </div>
      ) : null}
    </div>
  );
}, sameToolRow);

const LookupsRow = memo(function LookupsRow({ tools }: { tools: FlowTool[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`flow-tool is-ok flow-lookups${open ? " is-open" : ""}`}>
      <span className="flow-tool-dot" aria-hidden="true" />
      <button type="button" className="flow-tool-line" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="flow-tool-name">{lookupLabel(tools.map((t) => t.toolName))}</span>
        <span className="flow-caret" aria-hidden="true">
          ›
        </span>
      </button>
      {open ? (
        <div className="flow-lookups-list">
          {tools.map((tool) => (
            <ToolRow key={tool.id} tool={tool} />
          ))}
        </div>
      ) : null}
    </div>
  );
});

export function TranscriptFlow({
  items,
  sessionId,
  previewAccess,
  liveThinkingId,
  defaultThinkingExpanded = false,
  vscodeLiveId,
}: {
  items: FlowItem[];
  sessionId: string;
  /** #132/#147: each entry's HTML previews start the way its run's prompt described. */
  previewAccess: (entryId: string) => PreviewAccess;
  /** The thought still being written, shown open (#285, only with the thought-bubble preference). */
  liveThinkingId?: string | null;
  defaultThinkingExpanded?: boolean;
  /** #273: only the newest VS Code chip is live. */
  vscodeLiveId?: string;
}) {
  return (
    <>
      {items.map((item) => {
        const access = previewAccess(entryIdOf(item.id));
        let node: ReactNode;
        switch (item.kind) {
          case "user":
            node = <UserBlock id={item.id} text={item.view.text} images={item.view.images} />;
            break;
          case "prose":
            node = <Prose text={item.text} />;
            break;
          case "thinking":
            node = (
              <ThinkingRow
                blocks={item.blocks}
                seconds={item.seconds}
                live={item.id === liveThinkingId}
                defaultOpen={defaultThinkingExpanded}
              />
            );
            break;
          case "tool":
            node = <ToolRow tool={item} vscodeLive={item.id === vscodeLiveId} />;
            break;
          case "lookups":
            node = <LookupsRow tools={item.tools} />;
            break;
          case "passthrough":
            node = <EntryItem view={item.view} sessionId={sessionId} />;
            break;
        }
        return (
          <HtmlPreviewAccessContext.Provider key={item.id} value={access}>
            {node}
          </HtmlPreviewAccessContext.Provider>
        );
      })}
    </>
  );
}
