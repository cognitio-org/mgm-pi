import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import type { Voice } from "../hooks/useVoice.ts";
import type { Speaker } from "../hooks/useSpeaker.ts";
import { TTS_VOICES } from "../lib/tts-voices.ts";
import { isVoiceShortcut, VOICE_SHORTCUT_LABEL } from "../lib/voice-gesture.ts";
import { isTouchDeviceHere } from "../lib/touch.ts";
import { VoiceSpendView } from "./VoiceSpend.tsx";

/** #253: the Composer's mic. One button, two behaviours (owner decision on #251): a quick press
 * latches it on until the next press, press-and-hold talks until release. ⌥/Alt+Space does the same
 * from anywhere on the session page; Esc cancels and puts the draft back. The ▾ menu holds the
 * floppy's engine and the person's "after speaking" choice. */
export function VoiceControl({ voice, speaker }: { voice: Voice; speaker?: Speaker }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const optionsRef = useRef<HTMLButtonElement>(null);
  const live = useRef(voice);
  live.current = voice;
  const liveSpeaker = useRef(speaker);
  liveSpeaker.current = speaker;
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
      // Esc while a reply is being read: stop it (and step out of hands-free).
      if (e.key === "Escape" && liveSpeaker.current?.speaking && live.current.status === "idle" && !live.current.latched) {
        e.preventDefault();
        e.stopPropagation();
        liveSpeaker.current.stop();
        if (live.current.handsFree) live.current.cancel();
        return;
      }
      if (e.key === "Escape" && (live.current.status !== "idle" || live.current.latched)) {
        e.preventDefault();
        e.stopPropagation();
        if (menuRef.current) {
          setMenuOpen(false);
          optionsRef.current?.focus(); // the menu's own Esc handler, which does this, won't run
        }
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
    live.current.refreshMics(); // names appear once mic permission has been granted
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
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitemradio']:not(:disabled), [role='menuitem']:not(:disabled), [role='menuitemcheckbox']:not(:disabled)") ?? []);
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
        ref={voice.levelTarget as RefObject<HTMLButtonElement | null>}
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
      {speaker && (
        <button
          type="button"
          className={`voice-speaker${speaker.on ? " is-on" : ""}${speaker.speaking ? " is-speaking" : ""}`}
          aria-label="Read replies aloud"
          aria-pressed={speaker.on}
          title={speaker.on ? (speaker.speaking ? "Reading the reply (Esc stops)" : "Replies are read aloud") : "Read replies aloud"}
          onClick={() => speaker.setOn(!speaker.on)}
        >
          <SpeakerIcon on={speaker.on} />
        </button>
      )}
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
        // The popover holds the menu proper, then plain text (spend, hint) outside role="menu" so a
        // screen reader reads it rather than skipping non-items.
        <div ref={menuRef} className="enter-mode-menu voice-menu" onKeyDown={menuKeys}>
          <div role="menu" aria-label="Voice settings" className="voice-menu-items">
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
          <div role="group" aria-labelledby="voice-menu-mic" className="voice-menu-group">
            <div className="voice-menu-heading" id="voice-menu-mic">
              Microphone
            </div>
            <button type="button" role="menuitemradio" aria-checked={!voice.micId} onClick={() => voice.setMicId(undefined)}>
              System default
            </button>
            {voice.mics.map((m) => (
              <button
                key={m.id}
                type="button"
                role="menuitemradio"
                className="voice-mic-choice"
                aria-checked={voice.micId === m.id}
                title={m.label}
                onClick={() => voice.setMicId(m.id)}
              >
                {m.label}
              </button>
            ))}
            {voice.micId && !voice.mics.some((m) => m.id === voice.micId) && voice.micsLabelled && (
              <button type="button" role="menuitemradio" aria-checked={true} disabled>
                Chosen microphone (not connected)
              </button>
            )}
            {!voice.micsLabelled && voice.micsAvailable && (
              <button type="button" role="menuitem" onClick={() => voice.allowMicList()}>
                Show my microphones…
              </button>
            )}
          </div>
          {speaker && (
            <div role="group" aria-labelledby="voice-menu-replies" className="voice-menu-group">
              <div className="voice-menu-heading" id="voice-menu-replies">
                Replies
              </div>
              <button type="button" role="menuitemcheckbox" aria-checked={speaker.on} onClick={() => speaker.setOn(!speaker.on)}>
                Read replies aloud (this floppy)
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={voice.handsFree}
                onClick={() => {
                  const next = !voice.handsFree;
                  voice.setHandsFree(next);
                  if (next && !speaker.on) speaker.setOn(true); // the loop needs the reply read
                }}
              >
                Hands-free: talk, it sends, the reply is read, the mic reopens
              </button>
            </div>
          )}
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
          </div>
          {speaker && voice.deepgramAvailable && (
            <label className="voice-menu-group voice-tts-voice">
              <span className="voice-menu-heading">Reply voice</span>
              <select value={voice.ttsVoice} onChange={(e) => voice.setTtsVoice(e.target.value)}>
                {TTS_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.accent}
                    {v.gender ? `, ${v.gender}` : ""})
                  </option>
                ))}
              </select>
            </label>
          )}
          {voice.deepgramAvailable && (
            <section className="voice-menu-group" aria-labelledby="voice-menu-spend">
              <h4 className="voice-menu-heading" id="voice-menu-spend">
                Your Deepgram spend
              </h4>
              <VoiceSpendView compact />
            </section>
          )}
          {(voice.engine === "builtin" || (!voice.deepgramAvailable && voice.builtinAvailable)) && (
            <p className="voice-menu-hint">Browser built-in speech always uses the system default microphone.</p>
          )}
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

function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
      <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
      {on ? (
        <path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      ) : (
        <path d="M16 9l5 6M21 9l-5 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      )}
    </svg>
  );
}
