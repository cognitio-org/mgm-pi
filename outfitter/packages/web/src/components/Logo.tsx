// Outfitter mark: a pixel-grid rucksack (an outfitter equips expeditions) with a blinking
// terminal cursor tucked at its corner (the fleet is agents, i.e. "Gurus", at a prompt). Drawn on
// a 16x16 grid with square <rect> pixels (shape-rendering: crispEdges) so it reads as an artifact
// of the C64/GEOS/early-Mac world the rest of the theme borrows from, not a rounded app icon.
//
// Uses currentColor so it re-themes for free with the surrounding text colour; the blinking
// cursor pixel gets its own class so it can pick up the phosphor-green "live" colour and respect
// prefers-reduced-motion (see styles/base.css's .logo-cursor). Static duplicates of this mark
// live at src/assets/logo-mark.svg and src/assets/logo.svg (mark + wordmark) for use outside
// React (README, design docs); public/favicon.svg is a self-coloured variant of the same pixels
// since a favicon has no ancestor to inherit currentColor from.

interface LogoProps {
  variant?: "mark" | "full";
  size?: number;
  title?: string;
  className?: string;
}

export function Logo({ variant = "full", size = 22, title = "Outfitter", className }: LogoProps) {
  return (
    <span
      className={["logo", className].filter(Boolean).join(" ")}
      style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}
    >
      <LogoMark size={size} title={variant === "mark" ? title : undefined} />
      {variant === "full" && <span className="logo-wordmark">OUTFITTER</span>}
    </span>
  );
}

export function LogoMark({ size = 22, title }: { size?: number; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      shapeRendering="crispEdges"
      style={{ color: "var(--ok, currentColor)", flex: "none" }}
    >
      {title && <title>{title}</title>}
      <g fill="currentColor">
        {/* straps */}
        <rect x="5" y="0" width="2" height="5" />
        <rect x="9" y="0" width="2" height="5" />
        {/* top flap */}
        <rect x="4" y="3" width="8" height="2" />
        {/* body */}
        <rect x="3" y="4" width="10" height="11" />
        {/* buckle */}
        <rect x="7" y="6" width="2" height="2" fill="var(--bg-elevated, #fff)" />
        {/* front pocket (cut into the body at reduced opacity, reads as a panel line) */}
        <rect x="5" y="9" width="6" height="5" fill="var(--bg-elevated, #fff)" opacity="0.55" />
      </g>
      {/* blinking cursor, tucked at the pack's corner -- phosphor green in dark mode via --ok */}
      <rect className="logo-cursor" x="12" y="12" width="2" height="3" fill="var(--ok, currentColor)" />
    </svg>
  );
}
