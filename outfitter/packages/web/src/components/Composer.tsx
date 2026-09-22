import { useState } from "react";

interface Props {
  onSend: (text: string, behavior?: "steer" | "followUp") => Promise<void>;
  disabled?: boolean;
}

/** Send/steer/follow-up composer. "Send" queues a plain prompt (the API wakes a run if none is
 * running); "steer" and "follow-up" set `behavior` for a currently-running run (protocol.md's
 * `prompt.behavior`). */
export function Composer({ onSend, disabled }: Props) {
  const [text, setText] = useState("");
  const [behavior, setBehavior] = useState<"" | "steer" | "followUp">("");
  const [sending, setSending] = useState(false);

  async function send() {
    if (!text.trim()) return;
    setSending(true);
    try {
      await onSend(text, behavior || undefined);
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
          placeholder="Message..."
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
        <select value={behavior} onChange={(e) => setBehavior(e.target.value as typeof behavior)} disabled={disabled || sending}>
          <option value="">Send (queued if idle)</option>
          <option value="steer">Steer</option>
          <option value="followUp">Follow-up</option>
        </select>
        <button onClick={send} disabled={disabled || sending || !text.trim()}>
          {sending ? "Sending..." : "Send"}
        </button>
      </div>
    </div>
  );
}
