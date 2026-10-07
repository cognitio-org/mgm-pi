// Small square-cornered glyphs for the session page's chrome (#498), drawn on a 16px grid like the
// rest of the app's pixel marks. currentColor throughout, so they follow the theme.

export function SearchIcon() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      <circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 8l3 3" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

/** ◫ with the right column filled: the Details pane. */
export function PaneIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" fill="none" stroke="currentColor" />
      <rect x="10" y="3" width="4" height="10" fill="currentColor" opacity=".6" />
    </svg>
  );
}

/** ◫ with the left column filled: the Disk Box sidebar. */
export function SideIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" fill="none" stroke="currentColor" />
      <rect x="2" y="3" width="4" height="10" fill="currentColor" opacity=".6" />
    </svg>
  );
}

export function MoreIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="2" y="7" width="2.5" height="2.5" fill="currentColor" />
      <rect x="6.75" y="7" width="2.5" height="2.5" fill="currentColor" />
      <rect x="11.5" y="7" width="2.5" height="2.5" fill="currentColor" />
    </svg>
  );
}

export function BackIcon() {
  return (
    <svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true">
      <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" />
    </svg>
  );
}

export function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M8 2v12M2 8h12" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function SendIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
    </svg>
  );
}

export function StopIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <rect x="3" y="3" width="10" height="10" fill="currentColor" />
    </svg>
  );
}

/** A ring that fills with the share of the context window in use. */
export function ContextRing({ percent }: { percent: number }) {
  const r = 7;
  const c = 2 * Math.PI * r;
  const p = Math.min(100, Math.max(0, percent));
  const tone = p >= 80 ? "var(--danger)" : p >= 50 ? "var(--warn)" : "var(--ok)";
  return (
    <svg className="context-ring" viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
      <circle cx="9" cy="9" r={r} fill="none" stroke="var(--border)" strokeOpacity="0.5" strokeWidth="2.5" />
      <circle cx="9" cy="9" r={r} fill="none" stroke={tone} strokeWidth="2.5" strokeDasharray={`${(c * p) / 100} ${c}`} transform="rotate(-90 9 9)" />
    </svg>
  );
}
