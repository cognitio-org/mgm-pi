import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { VsCodeCard } from "./VsCodeCard.tsx";
import {
  collapseRail,
  railThinkingText,
  streamedThoughtItem,
  type Beat,
  type RailGlyph,
  type RailItem,
  type RailThinking,
  type RailTool,
} from "../lib/beats.ts";
import type { GroupedEntry } from "../lib/thinking.ts";
import { thinkingAccessibleLabel, thinkingWordLabel } from "../lib/thinking.ts";
import { ThinkingIcon, ToolboxIcon } from "./DeskIcons.tsx";
import { Markdown } from "./Markdown.tsx";
import { UserAttachments } from "./UserAttachments.tsx";

const HOVER_MS = 80;
// The card opens beside the glyph; this covers the gap so a peek can be reached.
const HIDE_MS = 120;
// How long the live bubble stays mounted while it shrinks into the rail glyph (#285).
// CSS transition is a little shorter so the shrink finishes before the node leaves.
export const THOUGHT_BUBBLE_COLLAPSE_MS = 240;

type OpenCard = { glyphId: string; pinned: boolean; toolId?: string };

function thinkingText(item: RailThinking): string {
  return railThinkingText(item);
}

function formatInput(input: unknown): string {
  if (input === undefined) return "";
  try {
    return JSON.stringify(input, null, 2) ?? "";
  } catch {
    return String(input);
  }
}

function inputPreview(input: unknown): string {
  if (input === undefined) return "";
  let text: string;
  try {
    text = typeof input === "string" ? input : (JSON.stringify(input) ?? "");
  } catch {
    return "";
  }
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 80 ? `${one.slice(0, 80).trimEnd()}…` : one;
}

const HINT_KEYS = ["command", "cmd", "path", "file_path", "filePath", "pattern", "query", "url", "name"];

/** A short, readable hint of what a tool call was about, for its visible label: the command, path
 * or query when the input has one (not the raw JSON), clipped to one line. */
export function toolHint(input: unknown): string {
  let text = "";
  if (typeof input === "string") text = input;
  else if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const key = HINT_KEYS.find((k) => typeof record[k] === "string" && (record[k] as string).trim());
    const value = key ? record[key] : Object.values(record).find((v) => typeof v === "string" && v.trim());
    text = typeof value === "string" ? value : "";
  }
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 60).trimEnd()}…` : one;
}

function GlyphLabel({ glyph }: { glyph: RailGlyph }) {
  if (glyph.kind === "batch") {
    const names = [...new Set(glyph.tools.map((tool) => tool.toolName))].join(", ");
    return (
      <span className="rail-glyph-label" aria-hidden="true">
        <span className="rail-glyph-name">{glyph.tools.length} tools</span>
        <span className="rail-glyph-hint">{names}</span>
      </span>
    );
  }
  if (glyph.item.kind === "thinking") {
    return (
      <span className="rail-glyph-label" aria-hidden="true">
        <span className="rail-glyph-name">thinking</span>
      </span>
    );
  }
  const tool = glyph.item;
  const hint = toolHint(tool.input);
  return (
    <span className="rail-glyph-label" aria-hidden="true">
      <span className="rail-glyph-name">{tool.toolName}</span>
      {hint ? <span className="rail-glyph-hint">{hint}</span> : null}
    </span>
  );
}

function glyphIdOf(glyph: RailGlyph): string {
  return glyph.kind === "batch" ? glyph.id : glyph.item.id;
}

function toolLabel(tool: RailTool): string {
  const state = tool.running ? ", running" : tool.interrupted ? ", interrupted" : tool.isError ? ", error" : "";
  return `Show tool ${tool.toolName}${state}`;
}

export function YouMark() {
  return (
    <span className="who who-user" role="img" aria-label="You">
      <svg width="16" height="16" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
        <g fill="currentColor">
          <rect x="6" y="1" width="4" height="1" />
          <rect x="5" y="2" width="6" height="4" />
          <rect x="6" y="6" width="4" height="1" />
          <rect x="7" y="7" width="2" height="1" />
          <rect x="4" y="8" width="8" height="1" />
          <rect x="3" y="9" width="10" height="2" />
          <rect x="2" y="11" width="4" height="3" />
          <rect x="10" y="11" width="4" height="3" />
        </g>
      </svg>
    </span>
  );
}

export function AssistantMark() {
  return (
    <span className="who who-assistant" role="img" aria-label="Assistant">
      <svg width="16" height="16" viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden="true">
        <g fill="currentColor">
          <rect x="5" y="0" width="2" height="5" />
          <rect x="9" y="0" width="2" height="5" />
          <rect x="4" y="3" width="8" height="2" />
          <rect x="3" y="4" width="10" height="11" />
          <rect x="7" y="6" width="2" height="2" fill="var(--mark-bg, var(--bg))" />
          <rect x="5" y="9" width="6" height="5" fill="var(--mark-bg, var(--bg))" opacity="0.55" />
        </g>
        <rect x="12" y="12" width="2" height="3" fill="currentColor" />
      </svg>
    </span>
  );
}

function placeCard(anchor: HTMLElement, card: HTMLElement) {
  const margin = 8;
  const phone = window.matchMedia("(max-width: 700px)").matches;
  if (phone) {
    const panel = anchor.closest(".panel") ?? anchor.closest(".transcript") ?? document.body;
    const bounds = panel.getBoundingClientRect();
    const width = Math.max(160, bounds.width - 16);
    card.style.maxWidth = "none";
    card.style.width = `${width}px`;
    card.style.left = `${bounds.left + margin}px`;
    const row = (anchor.closest(".rail") ?? anchor).getBoundingClientRect();
    const height = card.offsetHeight;
    let top = row.bottom + margin;
    if (top + height > window.innerHeight - margin) top = Math.max(margin, row.top - height - margin);
    card.style.top = `${top}px`;
    return;
  }
  card.style.maxWidth = "400px";
  card.style.width = "min(400px, calc(100vw - 16px))";
  const width = card.offsetWidth;
  const height = card.offsetHeight;
  const glyph = anchor.getBoundingClientRect();
  let left = glyph.left - width - 10;
  if (left < margin) left = Math.min(glyph.right + 10, window.innerWidth - width - margin);
  let top = glyph.top;
  if (top + height > window.innerHeight - margin) top = window.innerHeight - height - margin;
  if (top < margin) top = margin;
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function ToolBody({ tool }: { tool: RailTool }) {
  return (
    <>
      <div className="rail-block-label">Input</div>
      <pre>{formatInput(tool.input)}</pre>
      <div className="rail-block-label">Output</div>
      {tool.interrupted ? (
        <div className="rail-pending">Interrupted: the reply was cut off, so this call never ran.</div>
      ) : tool.running ? (
        <div className="rail-pending">
          <span className="rail-led" aria-hidden="true" />
          still running
        </div>
      ) : (
        <pre className={tool.isError ? "is-error" : undefined}>{tool.output ?? ""}</pre>
      )}
    </>
  );
}

function ExpandedThinking({ items }: { items: RailItem[] }) {
  const groups = items.filter((item): item is RailThinking => item.kind === "thinking");
  if (groups.length === 0) return null;
  return (
    <div className="rail-thinking-expanded">
      {groups.map((item) => (
        <p key={item.id} className="rail-thinking-body">
          {thinkingText(item)}
        </p>
      ))}
    </div>
  );
}

export function TranscriptRail({
  items,
  defaultThinkingExpanded = false,
  collapsingThinkingId,
  labelled = "never",
}: {
  items: RailItem[];
  defaultThinkingExpanded?: boolean;
  /** Where a glyph also shows its tool name and a hint: "always" in a tools-only row, which has the
   * width; "phone" beside prose, where the rail is a row above the text only on a phone. */
  labelled?: "always" | "phone" | "never";
  /** The thinking glyph the live bubble is shrinking into. */
  collapsingThinkingId?: string;
}) {
  const glyphs = collapseRail(items);
  const glyphKey = glyphs.map(glyphIdOf).join("\0");
  const railId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const pinnedRef = useRef(false);
  const hoverTimer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  const [open, setOpen] = useState<OpenCard | null>(null);
  const titleId = useId();

  function clearTimers() {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hoverTimer.current = null;
    hideTimer.current = null;
  }

  function close() {
    clearTimers();
    pinnedRef.current = false;
    anchorRef.current = null;
    setOpen(null);
  }

  function show(glyphId: string, anchor: HTMLElement, pinned: boolean) {
    clearTimers();
    pinnedRef.current = pinned;
    anchorRef.current = anchor;
    window.dispatchEvent(new CustomEvent("outfitter:rail-open", { detail: railId }));
    setOpen({ glyphId, pinned });
  }

  useEffect(() => {
    function onOther(event: Event) {
      if ((event as CustomEvent<string>).detail === railId) return;
      pinnedRef.current = false;
      anchorRef.current = null;
      setOpen(null);
    }
    window.addEventListener("outfitter:rail-open", onOther);
    return () => {
      window.removeEventListener("outfitter:rail-open", onOther);
      clearTimers();
    };
  }, [railId]);

  useEffect(() => {
    if (!open) return;
    const ids = glyphKey.length === 0 ? [] : glyphKey.split("\0");
    if (ids.includes(open.glyphId)) return;
    close();
  }, [glyphKey, open]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (document.querySelector("[aria-modal='true']")) return;
      event.preventDefault();
      close();
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (cardRef.current?.contains(target)) return;
      if (target instanceof Element && rootRef.current?.contains(target) && target.closest(".rail-glyph")) return;
      close();
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const active = open ? glyphs.find((glyph) => glyphIdOf(glyph) === open.glyphId) : undefined;
  const detailKey = open ? `${open.glyphId}:${open.toolId ?? ""}` : "";

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const card = cardRef.current;
    if (!open || !anchor || !card) return;
    const place = () => placeCard(anchor, card);
    place();
    // Same detailKey while a running body grows. Re-place on height, next frame so
    // placeCard's width write is not a ResizeObserver loop.
    let height = card.offsetHeight;
    let frame = 0;
    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const next = card.offsetHeight;
            if (next === height) return;
            height = next;
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
              place();
              height = card.offsetHeight;
            });
          });
    ro?.observe(card);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      ro?.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, detailKey]);

  function scheduleHide() {
    if (pinnedRef.current) return;
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      if (pinnedRef.current) return;
      if (cardRef.current?.matches(":hover")) return;
      if (rootRef.current?.querySelector(".rail-glyph:hover")) return;
      close();
    }, HIDE_MS);
  }

  let card: ReactNode = null;
  if (open && active) {
    const drilled = active.kind === "batch" ? active.tools.find((tool) => tool.id === open.toolId) : undefined;
    const singleTool = active.kind === "single" && active.item.kind === "tool" ? active.item : undefined;
    const singleThinking = active.kind === "single" && active.item.kind === "thinking" ? active.item : undefined;
    const tool = drilled ?? singleTool;
    const showList = active.kind === "batch" && !drilled;
    const title = showList ? "Tools" : tool ? tool.toolName : "Thinking";
    const meta = showList ? `×${active.tools.length}` : singleThinking ? thinkingWordLabel(thinkingText(singleThinking)) : undefined;
    const isError = Boolean(tool?.isError || tool?.interrupted);
    const isRunning = Boolean(tool?.running);
    card = (
      <div
        ref={cardRef}
        className={`rail-card${isError ? " is-error" : ""}${isRunning ? " is-running" : ""}`}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        onPointerEnter={() => {
          if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
        }}
        onPointerLeave={scheduleHide}
      >
        <div className="panel-titlebar">
          <span className="panel-label" id={titleId}>
            {isRunning ? <span className="rail-led" aria-hidden="true" /> : null}
            {title}
          </span>
          {meta ? <span className="rail-card-meta">{meta}</span> : null}
          <span className="rail-card-actions">
            {drilled ? (
              <button type="button" onClick={() => setOpen((current) => (current ? { ...current, toolId: undefined } : current))}>
                Back
              </button>
            ) : null}
            <button type="button" aria-label="Close" onClick={close}>
              ×
            </button>
          </span>
        </div>
        <div className="rail-card-body">
          {showList ? (
            <ul className="rail-tool-list">
              {active.tools.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => {
                      pinnedRef.current = true;
                      clearTimers();
                      setOpen((current) => (current ? { ...current, pinned: true, toolId: item.id } : current));
                    }}
                  >
                    <span className="rail-row-name">{item.toolName}</span>
                    <span className="rail-row-arg">{inputPreview(item.input)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {tool ? <ToolBody tool={tool} /> : null}
          {singleThinking ? <p className="rail-thinking-body">{thinkingText(singleThinking)}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className={`rail${labelled === "always" ? " is-labelled" : labelled === "phone" ? " is-labelled-phone" : ""}`} ref={rootRef}>
        {glyphs.map((glyph) => {
          const id = glyphIdOf(glyph);
          const thinkingItem = glyph.kind === "single" && glyph.item.kind === "thinking" ? glyph.item : undefined;
          const toolItem = glyph.kind === "single" && glyph.item.kind === "tool" ? glyph.item : undefined;
          const label = thinkingItem
            ? thinkingAccessibleLabel(thinkingText(thinkingItem), open?.glyphId === id)
            : toolItem
              ? toolLabel(toolItem)
              : `Show ${glyph.kind === "batch" ? glyph.tools.length : 0} tools`;
          const pressed = open?.pinned === true && open.glyphId === id;
          return (
            <button
              key={id}
              type="button"
              className={[
                "rail-glyph",
                thinkingItem ? "is-thinking" : "",
                thinkingItem && thinkingItem.id === collapsingThinkingId ? "is-receiving" : "",
                toolItem?.isError || toolItem?.interrupted ? "is-error" : "",
                toolItem?.running ? "is-running" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-label={label}
              aria-expanded={open?.glyphId === id}
              aria-pressed={pressed}
              aria-haspopup="dialog"
              onPointerEnter={(event) => {
                if (pinnedRef.current) return;
                if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
                if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
                const anchor = event.currentTarget;
                hoverTimer.current = window.setTimeout(() => {
                  if (pinnedRef.current) return;
                  show(id, anchor, false);
                }, HOVER_MS);
              }}
              onPointerLeave={scheduleHide}
              onClick={(event) => {
                if (open?.pinned && open.glyphId === id) {
                  close();
                  return;
                }
                show(id, event.currentTarget, true);
              }}
            >
              {thinkingItem ? <ThinkingIcon size={16} /> : <ToolboxIcon size={16} />}
              {toolItem?.running ? <span className="rail-led" aria-hidden="true" /> : null}
              {glyph.kind === "batch" && labelled !== "always" ? <span className="rail-badge">×{glyph.tools.length}</span> : null}
              {labelled !== "never" ? <GlyphLabel glyph={glyph} /> : null}
            </button>
          );
        })}
        {card}
      </div>
      {defaultThinkingExpanded ? <ExpandedThinking items={items} /> : null}
    </>
  );
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface BubbleState {
  item: RailThinking;
  collapsing: boolean;
}

/** Keeps the open thought on screen, then holds it for one shrink into the rail glyph after the
 * round finishes (#285). The id and the text are the effect deps: a new object with the same
 * words must not restart the shrink.
 *
 * `settleInto` is the beat's thinking items this frame. When the round ends in the same render
 * that replaces the group, the previous snapshot still says the old words; the rail's copy is
 * the one the shrink should show. `drop` removes it with no shrink: the transcript's own bubble
 * has taken over, and a second one would be the same thought twice. */
function useCollapsingThought(live: RailThinking | null, settleInto: readonly RailThinking[], drop = false): BubbleState | null {
  const liveRef = useRef(live);
  liveRef.current = live;
  const settleRef = useRef(settleInto);
  settleRef.current = settleInto;
  const dropRef = useRef(drop);
  dropRef.current = drop;
  const [bubble, setBubble] = useState<BubbleState | null>(() => (live && !drop ? { item: live, collapsing: false } : null));
  // The effect reads this instead of a setState updater: updaters run on the next render, too late
  // to decide whether a shrink timer is needed. Updated during render so it matches what's on screen.
  const bubbleRef = useRef(bubble);
  bubbleRef.current = bubble;
  const liveId = live?.id ?? null;
  const liveText = live ? thinkingText(live) : "";

  useEffect(() => {
    if (dropRef.current && !liveId) {
      if (bubbleRef.current) setBubble(null);
      return;
    }
    const current = liveRef.current;
    if (liveId && current && current.id === liveId) {
      setBubble({ item: current, collapsing: false });
      return;
    }
    const existing = bubbleRef.current;
    if (!existing) return;
    const match = settleRef.current.find((item) => item.id === existing.item.id);
    const item = match ?? existing.item;
    if (prefersReducedMotion()) {
      setBubble(null);
      return;
    }
    setBubble({ item, collapsing: true });
    const timer = window.setTimeout(() => setBubble(null), THOUGHT_BUBBLE_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [liveId, liveText, drop]);

  return bubble;
}

function ThoughtBubble({ item, collapsing }: { item: RailThinking; collapsing: boolean }) {
  const text = thinkingText(item);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // A reader who scrolled up inside the thought stays there. The pin only runs when they
  // were already at the bottom; the same few pixels as the transcript's own follow.
  const stickRef = useRef(true);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || collapsing || !stickRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [text, collapsing]);
  return (
    <div className={`thought-bubble-slot${collapsing ? " is-collapsing" : ""}`} data-thinking-id={item.id}>
      <div className="thought-bubble" role="region" aria-label="Thinking" aria-hidden={collapsing ? true : undefined}>
        <div className="thought-bubble-kicker" aria-hidden="true">
          <ThinkingIcon size={16} />
          <span>Thinking</span>
        </div>
        <div
          className="thought-bubble-body"
          ref={bodyRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 2;
          }}
        >
          {text.trim() ? text : "…"}
        </div>
      </div>
    </div>
  );
}

/** The open message is not an entry yet, so the thought has no rail glyph to sit beside (#285).
 * This row is that wait. `drop` is set once the transcript's own bubble has the thought: the
 * row disappears instead of shrinking a second copy. */
export function StreamedThought({ text, drop }: { text: string | null; drop: boolean }) {
  const live = text !== null ? streamedThoughtItem(text) : null;
  const bubble = useCollapsingThought(live, [], drop);
  if (!bubble) return null;
  return (
    <div className="beat tools-only has-thought-bubble">
      <div className="beat-copy">
        <ThoughtBubble item={bubble.item} collapsing={bubble.collapsing} />
      </div>
    </div>
  );
}

type VisibleBeat = Exclude<Beat, { kind: "passthrough" }>;

export function UserEntry({ view }: { view: Extract<GroupedEntry, { kind: "user" }> }) {
  return (
    <div className="entry user">
      <YouMark />
      <Markdown text={view.text} />
      {view.images && view.images.length > 0 ? <UserAttachments images={view.images} /> : null}
    </div>
  );
}

/** #273: a beat where the model's `vscode` tool ran (and didn't fail or get cut off). */
export function beatOpensVsCode(beat: { kind: string; rail?: RailItem[] }): boolean {
  return Boolean(beat.rail?.some((item) => item.kind === "tool" && item.toolName === "vscode" && !item.isError && !item.interrupted));
}

export function BeatView({
  beat,
  defaultThinkingExpanded = false,
  vscodeLive = true,
  liveThinkingId,
}: {
  beat: VisibleBeat;
  defaultThinkingExpanded?: boolean;
  /** #273: whether this beat's VS Code chip is the conversation's latest (live) one. */
  vscodeLive?: boolean;
  /** Id of the thinking round still in progress (#285). Absent once that round has finished. */
  liveThinkingId?: string;
}) {
  const live =
    beat.kind !== "user" && liveThinkingId
      ? (beat.rail.find((item): item is RailThinking => item.kind === "thinking" && item.id === liveThinkingId) ?? null)
      : null;
  // The rail's current copy of every thought on this beat, so the shrink can use words that
  // arrived in the same render that ended the round.
  const settle = beat.kind === "user" ? [] : beat.rail.filter((item): item is RailThinking => item.kind === "thinking");
  const bubble = useCollapsingThought(live, settle);
  if (beat.kind === "user") return <UserEntry view={beat.view} />;
  // #273: a beat where the model opened VS Code gets one chip for it, in the chat, not in the rail.
  const vscode = beatOpensVsCode(beat) ? <VsCodeCard live={vscodeLive} /> : null;
  const bubbleNode = bubble ? <ThoughtBubble item={bubble.item} collapsing={bubble.collapsing} /> : null;
  const collapsingThinkingId = bubble?.collapsing ? bubble.item.id : undefined;
  // The wrapper exists only while the bubble does, so a settled reply stays a direct .entry
  // (that is what stretches to the rail). The bubble is the conversation column; the glyph stays.
  const rail = (
    <TranscriptRail
      items={beat.rail}
      defaultThinkingExpanded={defaultThinkingExpanded}
      collapsingThinkingId={collapsingThinkingId}
      labelled={beat.kind === "tools-only" ? "always" : "phone"}
    />
  );
  if (beat.kind === "tools-only") {
    // The resting tools-only rail is a row at the start of the beat. The bubble sits under it
    // and shrinks upward, so the glyph is already where it will be when the bubble unmounts.
    return (
      <div className={`beat tools-only${bubbleNode ? " has-thought-bubble" : ""}`}>
        {rail}
        {bubbleNode ? <div className="beat-copy">{bubbleNode}</div> : null}
        {vscode}
      </div>
    );
  }
  const prose = (
    <div className="entry assistant-text">
      <AssistantMark />
      <Markdown text={beat.prose} />
    </div>
  );
  return (
    <div className={`beat${bubbleNode ? " has-thought-bubble" : ""}`}>
      {bubbleNode ? (
        <div className="beat-copy">
          {bubbleNode}
          {prose}
        </div>
      ) : (
        prose
      )}
      {rail}
      {vscode}
    </div>
  );
}
