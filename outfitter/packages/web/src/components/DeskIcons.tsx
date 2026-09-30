// Original pixel-art icon set for the GEOS-style desktop (DeskPage.tsx). Deliberately not GEOS or
// Berkeley Softworks artwork -- drawn from scratch on a 16x16 grid with square <rect> pixels
// (shape-rendering: crispEdges), using currentColor so every icon re-themes for free between the
// C64 phosphor and early-Mac looks. Each icon is a self-contained <svg> so it can be used both in
// the window's icon grid and as a standalone desktop icon.

import type { ReactNode } from "react";

interface IconProps {
  size?: number;
  className?: string;
}

function Grid({ size = 32, className, children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      className={className}
      shapeRendering="crispEdges"
      aria-hidden="true"
      style={{ flex: "none" }}
    >
      <g fill="currentColor">{children}</g>
    </svg>
  );
}

/** Disk Box -- the session list. A storage box of floppies, seen edge-on. */
export function DiskBoxIcon(props: IconProps) {
  return (
    <Grid {...props}>
      <rect x="1" y="3" width="14" height="11" />
      <rect x="2" y="1" width="12" height="2" />
      <rect x="2" y="5" width="10" height="7" fill="var(--bg-elevated, #fff)" />
      <rect x="3" y="6" width="1" height="5" />
      <rect x="5" y="6" width="1" height="5" />
      <rect x="7" y="6" width="1" height="5" />
      <rect x="9" y="6" width="1" height="5" />
    </Grid>
  );
}

/** New Floppy -- a 5.25" floppy disk with a plus/spark to mean "new". */
export function NewFloppyIcon(props: IconProps) {
  return (
    <Grid {...props}>
      <rect x="2" y="1" width="12" height="14" />
      <rect x="2" y="1" width="3" height="3" fill="var(--bg-elevated, #fff)" />
      <rect x="4" y="4" width="8" height="4" fill="var(--bg-elevated, #fff)" />
      <rect x="5" y="5" width="6" height="1" />
      <rect x="4" y="10" width="8" height="4" fill="var(--bg-elevated, #fff)" />
      <rect x="11" y="10" width="8" height="0" />
      <rect x="10" y="11" width="1" height="2" />
      {/* new-mark: small plus, phosphor green */}
      <rect x="12" y="10" width="1" height="3" fill="var(--ok, currentColor)" />
      <rect x="11" y="11" width="3" height="1" fill="var(--ok, currentColor)" />
    </Grid>
  );
}

/** Tapes -- gurus. A cassette shape: two reel windows and a label strip. */
export function TapesIcon(props: IconProps) {
  return (
    <Grid {...props}>
      <rect x="1" y="4" width="14" height="9" />
      <rect x="2" y="5" width="12" height="2" fill="var(--bg-elevated, #fff)" />
      <rect x="4" y="9" width="3" height="3" fill="var(--bg-elevated, #fff)" />
      <rect x="9" y="9" width="3" height="3" fill="var(--bg-elevated, #fff)" />
      <rect x="5" y="10" width="1" height="1" />
      <rect x="10" y="10" width="1" height="1" />
    </Grid>
  );
}

/** GitHub -- a commit splitting into two branches. Original pixel art, not the octocat. */
export function GithubIcon(props: IconProps) {
  return (
    <Grid {...props}>
      <rect x="1" y="7" width="5" height="2" />
      <rect x="5" y="4" width="2" height="4" />
      <rect x="6" y="3" width="5" height="2" />
      <rect x="11" y="2" width="3" height="3" />
      <rect x="12" y="3" width="1" height="1" fill="var(--bg-elevated, #fff)" />
      <rect x="5" y="8" width="2" height="4" />
      <rect x="6" y="11" width="5" height="2" />
      <rect x="11" y="10" width="3" height="3" />
      <rect x="12" y="11" width="1" height="1" fill="var(--bg-elevated, #fff)" />
    </Grid>
  );
}

/** Peripherals -- providers. A plug/cable connector. */
export function PeripheralsIcon(props: IconProps) {
  return (
    <Grid {...props}>
      <rect x="5" y="1" width="2" height="5" />
      <rect x="9" y="1" width="2" height="5" />
      <rect x="3" y="6" width="10" height="5" />
      <rect x="5" y="7" width="6" height="3" fill="var(--bg-elevated, #fff)" />
      <rect x="7" y="11" width="2" height="2" />
      <rect x="6" y="13" width="4" height="2" />
    </Grid>
  );
}

/** Dongles -- tokens. A USB-ish key fob shape. */
export function DonglesIcon(props: IconProps) {
  return (
    <Grid {...props}>
      <rect x="2" y="5" width="7" height="6" />
      <rect x="4" y="7" width="3" height="2" fill="var(--bg-elevated, #fff)" />
      <rect x="9" y="6" width="5" height="4" />
      <rect x="14" y="7" width="1" height="1" fill="var(--bg-elevated, #fff)" />
      <rect x="10" y="7" width="1" height="2" fill="var(--bg-elevated, #fff)" />
      <rect x="12" y="7" width="1" height="2" fill="var(--bg-elevated, #fff)" />
    </Grid>
  );
}

/** Control Panel -- settings. A switch/dial panel. */
export function ControlPanelIcon(props: IconProps) {
  return (
    <Grid {...props}>
      <rect x="1" y="2" width="14" height="12" />
      <rect x="3" y="4" width="3" height="8" fill="var(--bg-elevated, #fff)" />
      <rect x="3" y="7" width="3" height="2" />
      <rect x="7" y="4" width="3" height="8" fill="var(--bg-elevated, #fff)" />
      <rect x="7" y="5" width="3" height="2" />
      <rect x="11" y="4" width="2" height="8" fill="var(--bg-elevated, #fff)" />
      <rect x="11" y="9" width="2" height="2" />
    </Grid>
  );
}

/** Manual -- about/help. A booklet with a bent corner. */
export function ManualIcon(props: IconProps) {
  return (
    <Grid {...props}>
      <rect x="3" y="1" width="10" height="14" />
      <rect x="4" y="3" width="8" height="1" fill="var(--bg-elevated, #fff)" />
      <rect x="4" y="5" width="8" height="1" fill="var(--bg-elevated, #fff)" />
      <rect x="4" y="7" width="5" height="1" fill="var(--bg-elevated, #fff)" />
      <rect x="10" y="10" width="3" height="3" fill="var(--bg, #000)" />
      <rect x="10" y="10" width="3" height="3" fill="none" stroke="currentColor" />
    </Grid>
  );
}

/** Drives -- running sandboxes, the desktop's disk-drive icon. */
export function DriveIcon(props: IconProps) {
  return (
    <Grid {...props}>
      <rect x="1" y="4" width="14" height="8" />
      <rect x="2" y="10" width="1" height="1" fill="var(--ok, currentColor)" />
      <rect x="4" y="10" width="1" height="1" />
      <rect x="6" y="6" width="6" height="2" fill="var(--bg-elevated, #fff)" />
      <rect x="12" y="5" width="2" height="1" fill="var(--bg-elevated, #fff)" />
    </Grid>
  );
}

/** Trash -- stopped sessions. A wastebasket. */
export function TrashIcon(props: IconProps) {
  return (
    <Grid {...props}>
      <rect x="4" y="2" width="8" height="1" />
      <rect x="6" y="1" width="4" height="1" />
      <rect x="3" y="4" width="10" height="1" />
      <rect x="4" y="5" width="8" height="9" />
      <rect x="6" y="7" width="1" height="5" fill="var(--bg-elevated, #fff)" />
      <rect x="8" y="7" width="1" height="5" fill="var(--bg-elevated, #fff)" />
      <rect x="10" y="7" width="1" height="5" fill="var(--bg-elevated, #fff)" />
    </Grid>
  );
}

/** Thinking -- a small pixel thought bubble (a big cloud pixel plus two shrinking "trail" pixels
 * leading toward where the speaker would be), used as the glyph on a collapsed thinking row's
 * summary/chip (EntryItem.tsx). */
export function ThinkingIcon(props: IconProps) {
  return (
    <Grid {...props}>
      <rect x="5" y="2" width="8" height="6" />
      <rect x="4" y="3" width="1" height="4" />
      <rect x="13" y="3" width="1" height="4" />
      <rect x="6" y="1" width="6" height="1" />
      <rect x="6" y="8" width="6" height="1" />
      <rect x="4" y="10" width="2" height="2" />
      <rect x="2" y="13" width="1" height="1" />
    </Grid>
  );
}

/** Toolbox -- rail glyph for a tool call and its result. Box, handle, latch. */
export function ToolboxIcon(props: IconProps) {
  return (
    <Grid {...props}>
      <rect x="6" y="1" width="4" height="1" />
      <rect x="5" y="2" width="1" height="2" />
      <rect x="10" y="2" width="1" height="2" />
      <rect x="2" y="4" width="12" height="10" />
      <rect x="3" y="5" width="10" height="8" fill="var(--glyph-inset, var(--bg-elevated, #fff))" />
      <rect x="6" y="7" width="4" height="3" />
      <rect x="7" y="8" width="2" height="1" fill="var(--glyph-inset, var(--bg-elevated, #fff))" />
    </Grid>
  );
}
