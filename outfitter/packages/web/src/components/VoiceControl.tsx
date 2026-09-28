import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Voice } from "../hooks/useVoice.ts";
import { isVoiceShortcut, VOICE_SHORTCUT_LABEL } from "../lib/voice-gesture.ts";

/** #253: the Composer's mic. One button, two behaviours (owner decision on #251): a quick press
 * latches it on until the next press, press-and-hold talks until release. ⌥/Alt+Space does the same
 * from anywhere on the session page; Esc cancels and puts the draft back. The ▾ menu holds the
 * floppy's engine and the person's "after speaking" choice. */
export function VoiceControl({ voice }: { voice: Voice }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
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
        e.preventDefault(); // ⌥+Space would type a non-breaking space
        if (e.repeat || shortcutDown.current) return;
        shortcutDown.current = true;
        live.current.press();
        return;
      }
      if (e.key === "Escape" && (live.current.status !== "idle" || live.current.latched)) {
        e.preventDefault();
        e.stopPropagation();
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
      if (event.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const label = active ? "Stop voice input" : "Voice input";
  const hint = `Tap to keep listening, hold to talk (${VOICE_SHORTCUT_LABEL}). Esc cancels.`;

  return (
    <span className="voice-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`voice-mic${active ? " is-live" : ""}${voice.status === "finishing" ? " is-finishing" : ""}`}
        aria-label={label}
        aria-pressed={active}
        title={voice.usable ? hint : "Voice input isn't available here"}
        disabled={!voice.usable && !active}
        style={{ "--voice-level": voice.level } as CSSProperties}
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
        <div ref={menuRef} className="enter-mode-menu voice-menu" role="menu" aria-label="Voice settings">
          <div className="voice-menu-heading" role="presentation">
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
          <div className="voice-menu-heading" role="presentation">
            After speaking
          </div>
          <button type="button" role="menuitemradio" aria-checked={voice.afterSpeaking === "send"} onClick={() => voice.setAfterSpeaking("send")}>
            Send it
          </button>
          <button type="button" role="menuitemradio" aria-checked={voice.afterSpeaking === "review"} onClick={() => voice.setAfterSpeaking("review")}>
            Leave it to review
          </button>
          <div className="voice-menu-hint" role="presentation">
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
