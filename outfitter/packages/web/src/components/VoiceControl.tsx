import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Voice } from "../hooks/useVoice.ts";
import { isVoiceShortcut, VOICE_SHORTCUT_LABEL } from "../lib/voice-gesture.ts";
import { isTouchDeviceHere } from "../lib/touch.ts";

/** #253: the Composer's mic. One button, two behaviours (owner decision on #251): a quick press
 * latches it on until the next press, press-and-hold talks until release. ⌥/Alt+Space does the same
 * from anywhere on the session page; Esc cancels and puts the draft back. The ▾ menu holds the
 * floppy's engine and the person's "after speaking" choice. */
export function VoiceControl({ voice }: { voice: Voice }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const optionsRef = useRef<HTMLButtonElement>(null);
  const live = useRef(voice);
  live.current = voice;
  // Only a press that began on the button or the shortcut may end it: a stray keyup of Space
  // while typing mustn't stop a latched recording.
  const pointerDown = useRef(false);
  const shortcutDown = useRef(false);

  const active = voice.status !== "idle" || voice.latched;

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isVoiceShortcut(e)) {
        // Anywhere on the page except another text field (a dialog's input): that one is typing.
        if (editableOutsideComposer(e.target)) return;
        e.preventDefault(); // ⌥+Space would type a non-breaking space
        if (e.repeat || shortcutDown.current) return;
        shortcutDown.current = true;
        live.current.press();
        return;
      }
      // While the mic is live, Esc belongs to it (deliberately ahead of the page's other Esc
      // handlers): it cancels the recording and nothing else.
      if (e.key === "Escape" && (live.current.status !== "idle" || live.current.latched)) {
        e.preventDefault();
        e.stopPropagation();
        setMenuOpen(false);
        shortcutDown.current = false;
        pointerDown.current = false;
        live.current.cancel();
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      // Space or Alt going up ends a shortcut hold, whichever the person lets go of first.
      if (!shortcutDown.current || (e.code !== "Space" && e.key !== "Alt")) return;
      shortcutDown.current = false;
      live.current.release();
    }
    function onBlur() {
      // The keyup never arrives if focus leaves the window mid-hold.
      if (shortcutDown.current) {
        shortcutDown.current = false;
        live.current.release();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    function onPointer(event: PointerEvent) {
      if (event.target instanceof Node && wrapRef.current?.contains(event.target)) return;
      setMenuOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      optionsRef.current?.focus();
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  function menuKeys(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']:not(:disabled)") ?? []);
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next].focus();
  }

  const [touch] = useState(() => isTouchDeviceHere());
  // Phones have no shortcut or Esc to mention.
  const hint = touch ? "Tap to keep listening, hold to talk." : `Tap to keep listening, hold to talk (${VOICE_SHORTCUT_LABEL}). Esc cancels.`;

  return (
    <span className="voice-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`voice-mic${active ? " is-live" : ""}${voice.status === "finishing" ? " is-finishing" : ""}`}
        ref={(el) => {
          voice.levelTarget.current = el;
        }}
        aria-label="Voice input"
        aria-pressed={active}
        title={voice.usable ? hint : "Voice input isn't available here"}
        disabled={!voice.usable && !active}
        onPointerDown={(e) => {
          if (e.pointerType === "mouse" && e.button !== 0) return;
          e.preventDefault(); // keep focus (and the caret) in the message box
          e.currentTarget.setPointerCapture?.(e.pointerId);
          pointerDown.current = true;
          voice.press();
        }}
        onPointerUp={() => {
          if (!pointerDown.current) return;
          pointerDown.current = false;
          voice.release();
        }}
        onPointerCancel={() => {
          if (!pointerDown.current) return;
          pointerDown.current = false;
          voice.release();
        }}
        onKeyDown={(e) => {
          // A held Enter/Space would click again and again, toggling the mic each time.
          if (e.repeat && (e.key === "Enter" || e.key === " ")) e.preventDefault();
        }}
        onClick={(e) => {
          // Keyboard activation (Enter/Space on the focused button) has no pointer events: a tap.
          if (e.detail !== 0) return;
          voice.press();
          voice.release();
        }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <MicIcon />
      </button>
      <button
        ref={optionsRef}
        type="button"
        className="voice-options"
        aria-label="Voice settings"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="Voice settings"
        onClick={() => setMenuOpen((o) => !o)}
      >
        <span aria-hidden="true">▾</span>
      </button>
      {menuOpen && (
        <div ref={menuRef} className="enter-mode-menu voice-menu" role="menu" aria-label="Voice settings" onKeyDown={menuKeys}>
          <div role="group" aria-labelledby="voice-menu-engine" className="voice-menu-group">
          <div className="voice-menu-heading" id="voice-menu-engine">
            Engine (this floppy)
          </div>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={voice.engine === "deepgram"}
            disabled={!voice.deepgramAvailable}
            onClick={() => voice.setEngine("deepgram")}
          >
            {voice.deepgramAvailable ? "Deepgram" : "Deepgram (off here)"}
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={voice.engine === "builtin"}
            disabled={!voice.builtinAvailable}
            onClick={() => voice.setEngine("builtin")}
          >
            {voice.builtinAvailable ? "Browser built-in" : "Browser built-in (not in this browser)"}
          </button>
          </div>
          <div role="group" aria-labelledby="voice-menu-after" className="voice-menu-group">
          <div className="voice-menu-heading" id="voice-menu-after">
            After speaking
          </div>
          <button type="button" role="menuitemradio" aria-checked={voice.afterSpeaking === "send"} onClick={() => voice.setAfterSpeaking("send")}>
            Send it
          </button>
          <button type="button" role="menuitemradio" aria-checked={voice.afterSpeaking === "review"} onClick={() => voice.setAfterSpeaking("review")}>
            Leave it to review
          </button>
          </div>
          <div className="voice-menu-hint" aria-hidden="true">
            {hint}
          </div>
        </div>
      )}
    </span>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** A text field that isn't the composer's own box: typing ⌥+Space there must stay typing. */
function editableOutsideComposer(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const editable = target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
  return editable && !target.closest(".composer");
}
