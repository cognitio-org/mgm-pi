import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  collapseRail,
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

type OpenCard = { glyphId: string; pinned: boolean; toolId?: string };

function thinkingText(item: RailThinking): string {
  return item.blocks.map((block) => block.text).join("\n\n");
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

function glyphIdOf(glyph: RailGlyph): string {
  return glyph.kind === "batch" ? glyph.id : glyph.item.id;
}

function toolLabel(tool: RailTool): string {
  const state = tool.running ? ", running" : tool.isError ? ", error" : "";
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
      {tool.running ? (
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
}: {
  items: RailItem[];
  defaultThinkingExpanded?: boolean;
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
    const isError = Boolean(tool?.isError);
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
      <div className="rail" ref={rootRef}>
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
              className={["rail-glyph", thinkingItem ? "is-thinking" : "", toolItem?.isError ? "is-error" : "", toolItem?.running ? "is-running" : ""]
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
              {glyph.kind === "batch" ? <span className="rail-badge">×{glyph.tools.length}</span> : null}
            </button>
          );
        })}
        {card}
      </div>
      {defaultThinkingExpanded ? <ExpandedThinking items={items} /> : null}
    </>
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

export function BeatView({
  beat,
  defaultThinkingExpanded = false,
}: {
  beat: VisibleBeat;
  defaultThinkingExpanded?: boolean;
}) {
  if (beat.kind === "user") return <UserEntry view={beat.view} />;
  if (beat.kind === "tools-only") {
    return (
      <div className="beat tools-only">
        <TranscriptRail items={beat.rail} defaultThinkingExpanded={defaultThinkingExpanded} />
      </div>
    );
  }
  return (
    <div className="beat">
      <div className="entry assistant-text">
        <AssistantMark />
        <Markdown text={beat.prose} />
      </div>
      <TranscriptRail items={beat.rail} defaultThinkingExpanded={defaultThinkingExpanded} />
    </div>
  );
}
