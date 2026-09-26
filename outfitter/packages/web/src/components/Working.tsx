// Retro "busy" indicator, used everywhere the UI is sending, loading, or waiting on a run.
//
// The mark is a green Knight Rider scanner: one lamp sweeps across a short row and back,
// stepped, with no blur. It stays about 16px tall so a status line does not grow a row.
//
// Accessible by construction: role="status" + aria-live="polite" so assistive tech announces the
// label when it appears/changes, a visible or screen-reader-only label (never stripe-only), and a
// static (non-animated) rendering under prefers-reduced-motion -- see styles/components.css.

interface WorkingProps {
  /** Screen-reader (and, unless `srOnly`, visible) label describing what's happening. */
  label?: string;
  /** Visual size. "sm" sits inline in a button; "lg" is for page/panel/transcript states. */
  size?: "sm" | "lg";
  /** Hide the text label visually and expose it to assistive tech only (default for "sm"). */
  srOnly?: boolean;
  className?: string;
}

export function Working({ label = "Working", size = "sm", srOnly, className }: WorkingProps) {
  const hideLabel = srOnly ?? size === "sm";
  return (
    <span
      className={["working", `working-${size}`, className].filter(Boolean).join(" ")}
      role="status"
      aria-live="polite"
    >
      <span className="working-stripe" aria-hidden="true" />
      <span className={hideLabel ? "sr-only" : "working-label"}>{label}</span>
    </span>
  );
}
