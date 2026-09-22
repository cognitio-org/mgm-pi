// Retro "busy" indicator, used everywhere the UI is sending, loading, or waiting on a run.
//
// Primary design: a C64 cassette-loading border stripe -- the flickering striped bar a C64 draws
// around the screen edge while a tape loads. Chosen over two alternatives kept as documented SVGs
// in docs/design/ (an 8-point pixel ring "busy" spinner, and an early-Mac wristwatch cursor) --
// see docs/design/README.md for the one-line rationale on each. Motion is stepped, not eased, to
// match the rest of the theme's "no blur, no smooth gradients" language.
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
