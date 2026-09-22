// Original pixel-art icons for the retro error vocabulary (docs/reports/mobile-desk.md), drawn the
// same way as DeskIcons.tsx: a 16x16 grid of square <rect> pixels (shape-rendering: crispEdges),
// currentColor so they re-theme for free between the C64 phosphor and early-Mac looks.

import type { ReactNode } from "react";

interface IconProps {
  size?: number;
  className?: string;
}

function Grid({ size = 24, className, children }: IconProps & { children: ReactNode }) {
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

/** The classic early-Mac "bomb" -- a round body, a stub fuse, and a spark -- for
 * SystemErrorDialog.tsx's "Sorry, a system error occurred." alert. An original drawing, not a
 * reproduction of Apple's System 1-6 bomb icon. */
export function BombIcon(props: IconProps) {
  return (
    <Grid {...props}>
      {/* fuse */}
      <rect x="9" y="1" width="2" height="2" />
      <rect x="11" y="0" width="2" height="1" fill="var(--warn, currentColor)" />
      {/* body */}
      <rect x="4" y="5" width="8" height="1" />
      <rect x="3" y="6" width="10" height="7" />
      <rect x="4" y="13" width="8" height="1" />
      {/* highlight */}
      <rect x="5" y="7" width="2" height="2" fill="var(--bg-elevated, #fff)" />
    </Grid>
  );
}

/** A plug pulled out of its socket -- PROVIDER/DEVICE offline (ProvidersPage row detail, the
 * session model-unreachable banner, the offline banner). */
export function DeviceNotPresentIcon(props: IconProps) {
  return (
    <Grid {...props}>
      <rect x="1" y="6" width="6" height="4" />
      <rect x="2" y="4" width="1" height="2" />
      <rect x="5" y="4" width="1" height="2" />
      <rect x="9" y="7" width="2" height="2" />
      <rect x="12" y="7" width="1" height="2" />
      <rect x="14" y="6" width="1" height="1" />
      <rect x="14" y="9" width="1" height="1" />
    </Grid>
  );
}

/** A floppy with a crossed-out corner -- ?FILE NOT FOUND ERROR (the 404 route, unknown session
 * ids). */
export function FileNotFoundIcon(props: IconProps) {
  return (
    <Grid {...props}>
      <rect x="2" y="1" width="12" height="14" />
      <rect x="2" y="1" width="3" height="3" fill="var(--bg-elevated, #fff)" />
      <rect x="4" y="4" width="8" height="4" fill="var(--bg-elevated, #fff)" />
      <rect x="4" y="10" width="8" height="4" fill="var(--bg-elevated, #fff)" />
      <rect x="5" y="11" width="1" height="1" fill="var(--danger, currentColor)" />
      <rect x="6" y="12" width="1" height="1" fill="var(--danger, currentColor)" />
      <rect x="7" y="13" width="1" height="1" fill="var(--danger, currentColor)" />
      <rect x="11" y="11" width="1" height="1" fill="var(--danger, currentColor)" />
      <rect x="10" y="12" width="1" height="1" fill="var(--danger, currentColor)" />
      <rect x="9" y="13" width="1" height="1" fill="var(--danger, currentColor)" />
    </Grid>
  );
}
