import { useEffect, useId, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from "react";
import { Working } from "./Working.tsx";
import { MarkdownEditor } from "./MarkdownEditor.tsx";
import { withFloppySound } from "../lib/floppy-sound.ts";
import { isTouchDeviceHere } from "../lib/touch.ts";
import { loadEnterMode, saveEnterMode, type EnterMode } from "../lib/composer-keys.ts";

interface Props {
  /** The page's own "Sending…" phase (deriveSessionActivity) -- shown on the Send button too. */
  sending?: boolean;
  /** Called with the text as soon as the user sends; the composer clears straight away (the page
   * shows the message optimistically, with Retry if the POST fails -- cloud-fixes 11). */
  onSend: (text: string, behavior?: "steer" | "followUp") => Promise<void>;
  disabled?: boolean;
  /** Cloud-fixes 11: the send/wake/work status line, rendered in the composer's own top row so it
   * stays on screen (the composer is sticky on phones) instead of somewhere up the transcript. */
  status?: ReactNode;
  /** Replaces the computed touch/no-touch placeholder -- SessionPage passes "READY." while idle
   * (docs/reports/mobile-desk.md's retro status vocabulary), so the empty composer reads the same
   * "nothing is running, go ahead" cue as the session header's blinking-cursor status line. */
  placeholderOverride?: string;
}

type Behavior = "" | "steer" | "followUp";

const MODES: Array<{ value: Behavior; label: string; short: string }> = [
  // Short label "Prompt", not "Send": on phones the segmented control sits beside the Send button,
  // and two buttons both reading "Send" left it unclear which one sends.
  { value: "", label: "Prompt (queued if idle)", short: "Prompt" },
  { value: "steer", label: "Steer", short: "Steer" },
  { value: "followUp", label: "Follow-up", short: "Follow-up" },
];

/** Send/steer/follow-up composer. "Send" queues a plain prompt (the API wakes a run if none is
 * running); "steer" and "follow-up" set `behavior` for a currently-running run (protocol.md's
 * `prompt.behavior`). The mode picker is a `<select>` on desktop and a compact segmented control
 * on phones (styles/mobile.css toggles which one is visible) -- both drive the same `behavior`
 * state, so nothing about the send logic differs between them. */
export function Composer({ onSend, disabled, sending, placeholderOverride, status }: Props) {
  const [text, setText] = useState("");
  const [behavior, setBehavior] = useState<Behavior>("");
  // Read once per mount, not per render -- the device class doesn't change mid-session, and this
  // avoids calling matchMedia on every keystroke.
  const [touch] = useState(() => isTouchDeviceHere());
  // Cloud-fixes 12: remembered per browser; defaults to "newline" on touch devices, "send" on desktop.
  const [enterMode, setEnterMode] = useState<EnterMode>(() => loadEnterMode());
  const [enterMenu, setEnterMenu] = useState(false);
  // The formatting toolbar stays folded behind "Aa" until asked. It is rarely used.
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolbarId = useId();
  const sendWrapRef = useRef<HTMLSpanElement>(null);
  const enterMenuRef = useRef<HTMLDivElement>(null);
  const holdRef = useRef<number | null>(null);
  // Set when a hold already opened the menu, so the contextmenu that follows does not toggle it shut.
  const openedByHold = useRef(false);
  // The click that belongs to a right-click or a long-press must not send.
  const ignoreClick = useRef(false);

  function focusDraft() {
    sendWrapRef.current?.closest(".composer")?.querySelector("textarea")?.focus();
  }

  useEffect(() => {
    if (!enterMenu) return;
    enterMenuRef.current?.querySelector<HTMLButtonElement>("[aria-checked='true']")?.focus();
    function onPointer(event: globalThis.PointerEvent) {
      const target = event.target;
      if (target instanceof Node && enterMenuRef.current?.contains(target)) return;
      setEnterMenu(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setEnterMenu(false);
      focusDraft();
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [enterMenu]);

  function chooseEnterMode(next: EnterMode) {
    ignoreClick.current = false;
    openedByHold.current = false;
    setEnterMode(next);
    saveEnterMode(next);
    setEnterMenu(false);
    focusDraft();
  }

  function openEnterMenu(event: MouseEvent) {
    event.preventDefault();
    ignoreClick.current = true;
    if (openedByHold.current) {
      openedByHold.current = false;
      return;
    }
    setEnterMenu((open) => !open);
  }

  function armHold(event: PointerEvent) {
    if (event.pointerType === "mouse") {
      // Ctrl-click still has its contextmenu and click coming; leave the suppress flag alone.
      if (!event.ctrlKey) ignoreClick.current = false;
      return;
    }
    ignoreClick.current = false;
    if (holdRef.current != null) window.clearTimeout(holdRef.current);
    holdRef.current = window.setTimeout(() => {
      openedByHold.current = true;
      ignoreClick.current = true;
      setEnterMenu(true);
    }, 450);
  }

  function clearHold() {
    if (holdRef.current != null) window.clearTimeout(holdRef.current);
    holdRef.current = null;
  }

  function cancelHold() {
    clearHold();
    ignoreClick.current = true;
  }

  async function send() {
    if (!text.trim() || disabled) return;
    const sent = text;
    setText("");
    await withFloppySound(onSend(sent, behavior || undefined));
  }

  const sendKeyHint = enterMode === "send" ? "Enter to send, Shift+Enter for a new line" : "Shift+Enter or ⌘/Ctrl+Enter to send";

  return (
    <div className="composer">
      <div className="composer-row composer-status-row">
        <div className="composer-status">{status}</div>
        <button
          type="button"
          className="md-tools-toggle"
          aria-expanded={toolsOpen}
          aria-controls={toolbarId}
          aria-label="Formatting tools"
          title="Formatting tools"
          onClick={() => setToolsOpen((o) => !o)}
        >
          <span aria-hidden="true">Aa</span>
        </button>
      </div>
      <MarkdownEditor
        value={text}
        onChange={setText}
        onSend={() => void send()}
        enterMode={enterMode}
        placeholder={placeholderOverride ?? (touch ? "Message…" : `Message... (${sendKeyHint})`)}
        disabled={disabled}
        toolsOpen={toolsOpen}
        toolbarId={toolbarId}
      />
      <div className="composer-row">
        <select
          className="composer-mode-select"
          value={behavior}
          onChange={(e) => setBehavior(e.target.value as Behavior)}
          disabled={disabled}
          aria-label="Send mode"
        >
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
        <div className="composer-mode-buttons" role="radiogroup" aria-label="Send mode">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={behavior === m.value}
              className={behavior === m.value ? "active" : ""}
              disabled={disabled}
              onClick={() => setBehavior(m.value)}
            >
              {m.short}
            </button>
          ))}
        </div>
        <span
          className="send-wrap"
          data-enter-mode={enterMode}
          title="Right-click to set whether Enter sends"
          onContextMenu={openEnterMenu}
          onPointerDown={armHold}
          onPointerUp={clearHold}
          onPointerCancel={cancelHold}
          onPointerLeave={clearHold}
        >
          <button
            type="button"
            className="btn btn-primary"
            aria-haspopup="menu"
            aria-expanded={enterMenu}
            aria-disabled={disabled || !text.trim() ? true : undefined}
            onClick={(event) => {
              if (ignoreClick.current || event.ctrlKey || event.button !== 0) {
                ignoreClick.current = false;
                return;
              }
              setEnterMenu(false);
              void send();
            }}
          >
            {sending ? <Working label="Sending" /> : "Send"}
          </button>
          {enterMenu && (
            <div ref={enterMenuRef} className="enter-mode-menu" role="menu" aria-label="Enter key">
              <button type="button" role="menuitemradio" aria-checked={enterMode === "send"} onClick={() => chooseEnterMode("send")}>
                Enter sends
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={enterMode === "newline"}
                onClick={() => chooseEnterMode("newline")}
              >
                Enter is a new line
              </button>
            </div>
          )}
        </span>
      </div>
    </div>
  );
}
