import { useState } from "react";
import { Working } from "./Working.tsx";
import { withFloppySound } from "../lib/floppy-sound.ts";
import { isTouchDeviceHere } from "../lib/touch.ts";

interface Props {
  onSend: (text: string, behavior?: "steer" | "followUp") => Promise<void>;
  disabled?: boolean;
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
export function Composer({ onSend, disabled, placeholderOverride }: Props) {
  const [text, setText] = useState("");
  const [behavior, setBehavior] = useState<Behavior>("");
  const [sending, setSending] = useState(false);
  // Read once per mount, not per render -- the device class doesn't change mid-session, and this
  // avoids calling matchMedia on every keystroke.
  const [touch] = useState(() => isTouchDeviceHere());

  async function send() {
    if (!text.trim()) return;
    setSending(true);
    try {
      await withFloppySound(onSend(text, behavior || undefined));
      setText("");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="composer">
      <div className="composer-row">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholderOverride ?? (touch ? "Message…" : "Message... (⌘/Ctrl+Enter to send)")}
          aria-label="Message"
          disabled={disabled || sending}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
        />
      </div>
      <div className="composer-row">
        <select
          className="composer-mode-select"
          value={behavior}
          onChange={(e) => setBehavior(e.target.value as Behavior)}
          disabled={disabled || sending}
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
              disabled={disabled || sending}
              onClick={() => setBehavior(m.value)}
            >
              {m.short}
            </button>
          ))}
        </div>
        <button className="btn btn-primary" onClick={send} disabled={disabled || sending || !text.trim()}>
          {sending ? <Working label="Sending" /> : "Send"}
        </button>
      </div>
    </div>
  );
}
