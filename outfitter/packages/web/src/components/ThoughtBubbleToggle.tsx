import { useId } from "react";

/** Session status-bar control for the live thought bubble (#285). Off shows thinking only as the
 * rail glyph. On shows the thought in the transcript while that round is still going. */
export function ThoughtBubbleToggle({ on, onChange }: { on: boolean; onChange: (next: boolean) => void }) {
  const hintId = useId();
  const hint = on ? "Thinking shows in the transcript while it happens" : "Show thinking in the transcript while it happens";
  return (
    <>
      <button
        type="button"
        className={`thought-bubble-toggle${on ? " is-on" : ""}`}
        aria-pressed={on}
        aria-label={on ? "Thoughts, live thinking on" : "Thoughts, live thinking off"}
        aria-describedby={hintId}
        title={hint}
        onClick={() => onChange(!on)}
      >
        Thoughts
      </button>
      <span id={hintId} className="sr-only">
        {hint}
      </span>
    </>
  );
}
