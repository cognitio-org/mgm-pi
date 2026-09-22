// Original pixel-art scenes for the Manual tour, drawn the same way as src/components/Logo.tsx and
// src/components/Working.tsx: square <rect> pixels, shapeRendering="crispEdges", currentColor plus
// the theme's --ok/--warn/--accent tokens so every scene re-themes for free between GEOS paper and
// C64 phosphor. Each scene is a small, self-contained SVG group mounted fresh per scene change (see
// TourAnimation.tsx, which keys on scene id) so its CSS entrance/loop animations restart cleanly.
//
// Layout: every scene is drawn on the same 320x180 viewBox as the monitor screen.

import type { ReactElement } from "react";

const VB = "0 0 320 180";

function ScreenText({ x, y, children, size = 10 }: { x: number | string; y: number | string; children: string; size?: number | string }) {
  return (
    <text x={x} y={y} fontFamily="var(--font-display)" fontSize={size} fill="currentColor" letterSpacing="1">
      {children}
    </text>
  );
}

export function OpeningScene() {
  return (
    <svg viewBox={VB} shapeRendering="crispEdges" className="tour-scene-svg tour-scene-opening">
      <g className="tour-border-flicker">
        <rect x="0" y="0" width="320" height="8" fill="var(--warn)" />
        <rect x="0" y="172" width="320" height="8" fill="var(--warn)" />
        <rect x="0" y="0" width="8" height="180" fill="var(--danger)" />
        <rect x="312" y="0" width="8" height="180" fill="var(--danger)" />
      </g>
      <g className="tour-fade-in">
        <ScreenText x="60" y="80" size="14">
          PRESS PLAY ON TAPE
        </ScreenText>
        <ScreenText x="120" y="110" size="12">
          LOADING
        </ScreenText>
        <rect x="120" y="118" width="6" height="6" className="tour-blink-a" fill="var(--ok)" />
        <rect x="130" y="118" width="6" height="6" className="tour-blink-b" fill="var(--ok)" />
        <rect x="140" y="118" width="6" height="6" className="tour-blink-c" fill="var(--ok)" />
      </g>
    </svg>
  );
}

/** Scene 1: a friendly pixel CPU/ROM chip wakes up with a blinking cursor, "READY." */
export function KernalScene() {
  return (
    <svg viewBox={VB} shapeRendering="crispEdges" className="tour-scene-svg">
      <g className="tour-slide-up" transform="translate(120,40)">
        {/* chip body */}
        <rect x="0" y="10" width="80" height="60" fill="var(--bg-inset)" stroke="currentColor" strokeWidth="2" />
        {/* pins */}
        {[0, 1, 2, 3].map((i) => (
          <rect key={`t${i}`} x={10 + i * 20} y="0" width="8" height="10" fill="currentColor" />
        ))}
        {[0, 1, 2, 3].map((i) => (
          <rect key={`b${i}`} x={10 + i * 20} y="70" width="8" height="10" fill="currentColor" />
        ))}
        {/* face: two eyes + blinking cursor mouth */}
        <rect x="18" y="28" width="10" height="10" fill="var(--ok)" className="tour-eye-blink" />
        <rect x="52" y="28" width="10" height="10" fill="var(--ok)" className="tour-eye-blink" />
        <rect x="24" y="50" width="32" height="8" fill="var(--ok)" className="tour-cursor-blink" />
      </g>
      <g className="tour-fade-in-late">
        <ScreenText x="128" y="135" size="14">
          READY.
        </ScreenText>
      </g>
    </svg>
  );
}

/** Scene 2: a cassette labelled with a model name clicks into a deck. */
export function TapesScene() {
  return (
    <svg viewBox={VB} shapeRendering="crispEdges" className="tour-scene-svg">
      {/* deck slot */}
      <rect x="90" y="90" width="140" height="14" fill="var(--bg-inset)" stroke="currentColor" strokeWidth="2" />
      <g className="tour-cassette-drop">
        {/* cassette body */}
        <rect x="100" y="20" width="120" height="70" fill="var(--accent)" stroke="currentColor" strokeWidth="2" />
        <rect x="112" y="32" width="96" height="20" fill="var(--bg-elevated)" />
        <ScreenText x="118" y="46" size="9">
          claude-opus
        </ScreenText>
        <circle cx="130" cy="70" r="10" fill="var(--bg-elevated)" stroke="currentColor" strokeWidth="2" />
        <circle cx="190" cy="70" r="10" fill="var(--bg-elevated)" stroke="currentColor" strokeWidth="2" />
      </g>
      <g className="tour-fade-in-late">
        <ScreenText x="76" y="150" size="11">
          Tapes = saved agent setups
        </ScreenText>
      </g>
    </svg>
  );
}

/** Scene 3: a 5.25" floppy labelled "Fix login bug" slides out of the Disk Box. */
export function FloppiesScene() {
  return (
    <svg viewBox={VB} shapeRendering="crispEdges" className="tour-scene-svg">
      {/* box */}
      <rect x="20" y="60" width="90" height="60" fill="var(--bg-inset)" stroke="currentColor" strokeWidth="2" />
      <ScreenText x="34" y="90" size="9">
        DISK BOX
      </ScreenText>
      <g className="tour-floppy-slide">
        <rect x="140" y="40" width="90" height="90" fill="var(--bg-elevated)" stroke="currentColor" strokeWidth="2" />
        <rect x="150" y="48" width="70" height="18" fill="var(--accent)" />
        <ScreenText x="154" y="61" size="8">
          Fix login bug
        </ScreenText>
        <circle cx="185" cy="95" r="18" fill="var(--bg-inset)" stroke="currentColor" strokeWidth="2" />
        <circle cx="185" cy="95" r="4" fill="currentColor" />
        <rect x="140" y="116" width="90" height="6" fill="currentColor" />
      </g>
      <g className="tour-fade-in-late">
        <ScreenText x="70" y="155" size="11">
          One conversation, saved
        </ScreenText>
      </g>
    </svg>
  );
}

/** Scene 4: the floppy goes into a drive in the cloud; light blinks, disk spins, output scrolls. */
export function DrivesScene() {
  return (
    <svg viewBox={VB} shapeRendering="crispEdges" className="tour-scene-svg">
      {/* cloud */}
      <g fill="var(--bg-inset)" stroke="currentColor" strokeWidth="2">
        <rect x="30" y="30" width="120" height="16" />
        <rect x="42" y="18" width="40" height="16" />
        <rect x="90" y="14" width="36" height="20" />
      </g>
      {/* drive inside the cloud */}
      <rect x="55" y="46" width="70" height="34" fill="var(--bg-elevated)" stroke="currentColor" strokeWidth="2" />
      <rect x="62" y="70" width="8" height="6" className="tour-drive-light" fill="var(--ok)" />
      <circle cx="105" cy="62" r="9" className="tour-disk-spin" fill="none" stroke="var(--ok)" strokeWidth="2" />

      {/* kernal chip working, output scrolling */}
      <rect x="200" y="30" width="70" height="50" fill="var(--bg-inset)" stroke="currentColor" strokeWidth="2" />
      <ScreenText x="206" y="44" size="8">
        agentd
      </ScreenText>
      <g className="tour-output-scroll">
        <rect x="206" y="50" width={34} className="tour-line-a" height="4" fill="var(--ok)" />
        <rect x="206" y="58" width={46} className="tour-line-b" height="4" fill="var(--ok)" />
        <rect x="206" y="66" width={28} className="tour-line-c" height="4" fill="var(--ok)" />
      </g>
      <g className="tour-fade-in-late">
        <ScreenText x="58" y="150" size="11">
          A Drive runs the agent, live
        </ScreenText>
      </g>
    </svg>
  );
}

/** Scene 5: the floppy returns to the box among others, some stopped; Play spins one up again. */
export function DiskBoxScene() {
  const disks = [
    { x: 30, state: "stopped" },
    { x: 90, state: "stopped" },
    { x: 150, state: "playing" },
    { x: 210, state: "stopped" },
  ];
  return (
    <svg viewBox={VB} shapeRendering="crispEdges" className="tour-scene-svg">
      <rect x="10" y="20" width="260" height="110" fill="var(--bg-inset)" stroke="currentColor" strokeWidth="2" />
      {disks.map((d) => (
        <g key={d.x} transform={`translate(${d.x},40)`}>
          <rect width="48" height="60" fill="var(--bg-elevated)" stroke="currentColor" strokeWidth="2" />
          <rect x="6" y="6" width="36" height="10" fill="var(--border)" />
          <circle cx="24" cy="42" r="10" fill="var(--bg-inset)" stroke="currentColor" strokeWidth="2" />
          {d.state === "playing" ? (
            <g className="tour-disk-spin-slow" transform="translate(24,42)">
              <rect x="-1" y="-10" width="2" height="10" fill="var(--ok)" />
            </g>
          ) : (
            <rect x="20" y="38" width="8" height="8" fill="var(--text-dim)" />
          )}
        </g>
      ))}
      <g className="tour-play-badge" transform="translate(150,20)">
        <polygon points="0,-14 12,-6 0,2" fill="var(--ok)" />
      </g>
      <g className="tour-fade-in-late">
        <ScreenText x="34" y="150" size="11">
          Stopped floppies wake with Play
        </ScreenText>
      </g>
    </svg>
  );
}

/** Scene 6: the floppy ejects and flies to a laptop; a terminal shows the teleport command. */
export function EjectScene() {
  return (
    <svg viewBox={VB} shapeRendering="crispEdges" className="tour-scene-svg">
      <g className="tour-eject-fly">
        <rect x="20" y="30" width="60" height="60" fill="var(--bg-elevated)" stroke="currentColor" strokeWidth="2" />
        <rect x="26" y="36" width="48" height="12" fill="var(--accent)" />
        <circle cx="50" cy="70" r="12" fill="var(--bg-inset)" stroke="currentColor" strokeWidth="2" />
        <polygon points="50,58 44,70 56,70" fill="var(--ok)" />
      </g>
      {/* laptop */}
      <g transform="translate(160,70)">
        <rect x="0" y="0" width="120" height="60" fill="var(--bg-inset)" stroke="currentColor" strokeWidth="2" />
        <rect x="-10" y="60" width="140" height="8" fill="currentColor" />
        <rect x="8" y="10" width="104" height="42" fill="#000" />
        <text x="14" y="26" fontFamily="var(--font-mono)" fontSize="7" fill="var(--ok)">
          $ kernal --teleport
        </text>
        <text x="14" y="36" fontFamily="var(--font-mono)" fontSize="7" fill="var(--ok)">
          01a0bb9f
        </text>
        <rect x="14" y="42" width="6" height="8" className="tour-cursor-blink" fill="var(--ok)" />
      </g>
      <g className="tour-fade-in-late">
        <ScreenText x="60" y="155" size="11">
          Continue on your laptop
        </ScreenText>
      </g>
    </svg>
  );
}

/** Scene 7: three-beat pan across a modem (Peripherals), a dongle (Dongles), a control panel with
 * a padlock marked Sysop. Uses a single CSS animation that pans a wide track. */
export function PeripheralsScene() {
  return (
    <svg viewBox={VB} shapeRendering="crispEdges" className="tour-scene-svg tour-scene-clip">
      <g className="tour-pan-track">
        {/* beat 1: modem / peripherals */}
        <g transform="translate(20,30)">
          <rect width="90" height="50" fill="var(--bg-inset)" stroke="currentColor" strokeWidth="2" />
          {[0, 1, 2, 3, 4].map((i) => (
            <rect key={i} x={8 + i * 16} y="10" width="8" height="8" className="tour-modem-blink" fill="var(--ok)" />
          ))}
          <ScreenText x="10" y="108" size="10">
            Peripherals
          </ScreenText>
        </g>
        {/* beat 2: dongle */}
        <g transform="translate(160,30)">
          <rect x="20" y="0" width="20" height="30" fill="var(--bg-elevated)" stroke="currentColor" strokeWidth="2" />
          <rect x="10" y="30" width="40" height="40" fill="var(--accent)" stroke="currentColor" strokeWidth="2" />
          <rect x="24" y="42" width="12" height="12" fill="var(--bg-elevated)" />
          <ScreenText x="4" y="108" size="10">
            Dongles
          </ScreenText>
        </g>
        {/* beat 3: control panel with padlock */}
        <g transform="translate(300,20)">
          <rect width="90" height="60" fill="var(--bg-inset)" stroke="currentColor" strokeWidth="2" />
          <rect x="30" y="18" width="30" height="24" fill="var(--bg-elevated)" stroke="currentColor" strokeWidth="2" />
          <rect x="38" y="8" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" />
          <ScreenText x="6" y="98" size="9">
            Control Panel
          </ScreenText>
          <ScreenText x="18" y="112" size="8">
            (Sysop only)
          </ScreenText>
        </g>
      </g>
      <g className="tour-fade-in-late">
        <ScreenText x="30" y="160" size="10">
          Providers, tokens, and settings
        </ScreenText>
      </g>
    </svg>
  );
}

export function ClosingScene() {
  return (
    <svg viewBox={VB} shapeRendering="crispEdges" className="tour-scene-svg">
      <g className="tour-fade-in">
        <ScreenText x="128" y="85" size="16">
          READY.
        </ScreenText>
        <rect x="128" y="94" width="10" height="10" className="tour-cursor-blink" fill="var(--ok)" />
      </g>
    </svg>
  );
}

export const SCENE_COMPONENTS: Record<string, () => ReactElement> = {
  opening: OpeningScene,
  kernal: KernalScene,
  tapes: TapesScene,
  floppies: FloppiesScene,
  drives: DrivesScene,
  diskbox: DiskBoxScene,
  eject: EjectScene,
  peripherals: PeripheralsScene,
  closing: ClosingScene,
};
