// "FLOPPY RESCUE" -- the main easter-egg game, inspired by (not a copy of) Choplifter: fly a pixel
// helicopter from the Disk Box (home base) out over a scrolling landscape to a burning server farm,
// land, let little Floppy characters board (capacity 8), then fly them home to unload for score.
// No shared names, art, sound or level layout with Choplifter -- see
// docs/reports/easter-egg-research.md for the design rationale.
//
// Self-contained: this component (plus engine.ts/sprites.ts/sound.ts) is the entire feature
// surface, always loaded via a dynamic import (see EasterEggRoot.tsx) so it costs nothing in the
// main bundle until triggered.
//
// Rendering: a low-res (320x176) logical canvas scaled up by CSS (`image-rendering: pixelated`,
// see .easter-canvas) so the world and sprites read as chunky, legible pixel art filling the frame
// -- see engine.ts's header comment. The helicopter is drawn from primitive rects (organic
// silhouette + rotor animation + tilt rotation are easier to get right this way than with a
// hand-typed character grid); racks/flames/Floppies/debris/drone are small character-grid sprites
// (sprites.ts). A compact HUD (score/level/onboard/fuel/lives) plus a distance minimap are drawn
// directly onto the canvas, C64-style, in addition to the larger accessible HTML HUD below it.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  attractInput,
  CAPACITY,
  createInitialState,
  FARM_PAD_W,
  GROUND_Y,
  HOME_PAD_W,
  playerTilt,
  step,
  togglePause,
  WORLD_H,
  WORLD_W,
  type GameEvent,
  type GameInput,
  type GameState,
} from "./engine.ts";
import {
  playBoard,
  playCrash,
  playDeliver,
  playFloppyLost,
  playFullLoadBonus,
  playGameOver,
  playThud,
  startRotor,
  stopRotor,
} from "./sound.ts";
import { readHighScore, writeHighScoreIfBetter } from "../shared/highscore.ts";
import { usesReducedMotion } from "../shared/motion.ts";
import { useFixedStepLoop } from "../shared/fixedStep.ts";
import { readGamepadButtons, readGamepadDirection } from "../shared/gamepad.ts";
import { spawnExplosionParticles, stepParticles, stepShake, triggerShake, shakeOffset, type Particle, type ShakeState } from "../shared/particles.ts";
import { drawSprite } from "../shared/pixelSprite.ts";
import {
  DEBRIS_PALETTE,
  DEBRIS_SPRITE,
  DRONE_PALETTE,
  DRONE_SPRITE,
  FLAME_PALETTE,
  FLAME_SPRITES,
  FLOPPY_PALETTE,
  FLOPPY_WALKER_SPRITES,
  RACK_PALETTE,
  RACK_UNIT_SPRITE,
  SPRITE_SCALE,
} from "./sprites.ts";

interface FloppyRescueProps {
  onClose: () => void;
}

function readQueryFlag(name: string): boolean {
  try {
    return new URLSearchParams(window.location.search).get(name) === "1";
  } catch {
    return false;
  }
}

export function FloppyRescue({ onClose }: FloppyRescueProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<GameState>(createInitialState(Date.now() & 0xffffffff));
  const inputRef = useRef<GameInput>({ up: false, down: false, left: false, right: false });
  const particlesRef = useRef<Particle[]>([]);
  const shakeRef = useRef<ShakeState | null>(null);
  const lastPauseButtonRef = useRef(false);
  const wasAirborneRef = useRef(false);
  const [, forceRender] = useState(0);
  const [highScore, setHighScore] = useState(() => readHighScore("rescue"));
  const reducedMotion = useMemo(() => usesReducedMotion(), []);
  const [calmAcknowledged, setCalmAcknowledged] = useState(!reducedMotion);
  const [screen, setScreen] = useState<"title" | "game">("title");
  const autoDemo = useMemo(() => readQueryFlag("demo"), []);
  // ?touch=1 forces the on-screen touch controls on regardless of pointer/hover media features, so
  // a headless browser (which reports a fine pointer even at phone viewport widths) can still be
  // screenshotted with them visible for review/documentation.
  const forceTouch = useMemo(() => readQueryFlag("touch"), []);

  const exit = useCallback(() => {
    stopRotor();
    writeHighScoreIfBetter("rescue", stateRef.current.score);
    onClose();
  }, [onClose]);

  function startGame() {
    stateRef.current = createInitialState(Date.now() & 0xffffffff);
    particlesRef.current = [];
    shakeRef.current = null;
    setScreen("game");
  }

  // --- keyboard controls ---
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        exit();
        return;
      }
      if (screen === "title") {
        if (!calmAcknowledged) return;
        startGame();
        return;
      }
      if (e.key === "p" || e.key === "P") {
        stateRef.current = togglePause(stateRef.current);
        forceRender((n) => n + 1);
        return;
      }
      if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") inputRef.current.up = true;
      if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") inputRef.current.down = true;
      if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") inputRef.current.left = true;
      if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") inputRef.current.right = true;
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") inputRef.current.up = false;
      if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") inputRef.current.down = false;
      if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") inputRef.current.left = false;
      if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") inputRef.current.right = false;
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [exit, screen, calmAcknowledged]);

  useEffect(() => {
    if (autoDemo && screen === "title" && calmAcknowledged) startGame();
  }, [autoDemo, calmAcknowledged]);

  // stop the rotor hum on unmount no matter how the component goes away
  useEffect(() => () => stopRotor(), []);

  function applyEvents(events: GameEvent[]) {
    for (const ev of events) {
      if (ev.type === "boarded") playBoard();
      else if (ev.type === "delivered") {
        if (ev.count === CAPACITY) playFullLoadBonus();
        else playDeliver();
      } else if (ev.type === "crash") {
        playCrash();
        if (!reducedMotion) {
          particlesRef.current = particlesRef.current.concat(
            spawnExplosionParticles(stateRef.current.playerX, stateRef.current.playerY, 16, "#ff8a8a"),
          );
          shakeRef.current = triggerShake(8);
        }
      } else if (ev.type === "floppyLost") playFloppyLost();
    }
  }

  const loopActive = calmAcknowledged;
  const onStep = useCallback(
    (dtMs: number) => {
      if (screen === "title") {
        const before = stateRef.current;
        const botInput = attractInput(before);
        let after = step(before, botInput, dtMs);
        if (after.status === "gameover") after = createInitialState((Date.now() + before.t) & 0xffffffff);
        stateRef.current = after;
        particlesRef.current = stepParticles(particlesRef.current, dtMs);
        return;
      }

      const gp = readGamepadDirection();
      const gpButtons = readGamepadButtons();
      // ?demo=1 keeps the attract-mode autopilot flying past the title screen too, so a headless
      // screenshot/video of "mid-game" shows real rescue action instead of an unpiloted helicopter.
      const merged: GameInput = autoDemo
        ? attractInput(stateRef.current)
        : {
            up: inputRef.current.up || gp.up || gpButtons.fire,
            down: inputRef.current.down || gp.down,
            left: inputRef.current.left || gp.left,
            right: inputRef.current.right || gp.right,
          };
      if (gpButtons.pause && !lastPauseButtonRef.current) {
        stateRef.current = togglePause(stateRef.current);
      }
      lastPauseButtonRef.current = gpButtons.pause;

      const before = stateRef.current;
      const after = step(before, merged, dtMs);
      stateRef.current = after;
      particlesRef.current = stepParticles(particlesRef.current, dtMs);
      shakeRef.current = stepShake(shakeRef.current, dtMs);

      if (after.status === "playing" || after.status === "levelIntro") {
        const airborne = after.playerY + 14 < GROUND_Y - 1;
        if (airborne && !wasAirborneRef.current) startRotor();
        if (!airborne && wasAirborneRef.current && Math.abs(after.playerVy) < 1) playThud();
        wasAirborneRef.current = airborne;
        applyEvents(after.events);
      } else if (after.status === "gameover" && before.status !== "gameover") {
        stopRotor();
        applyEvents(after.events);
        playGameOver();
        setHighScore(writeHighScoreIfBetter("rescue", after.score));
      }
    },
    [screen, reducedMotion, autoDemo],
  );

  const onRender = useCallback(() => {
    draw(canvasRef.current, stateRef.current, particlesRef.current, shakeRef.current, reducedMotion, screen, highScore);
    forceRender((n) => (n + 1) % 1000000);
  }, [reducedMotion, screen, highScore]);
  useFixedStepLoop(onStep, onRender, loopActive);

  function restart() {
    stopRotor();
    startGame();
  }

  const s = stateRef.current;
  const status = s.status;
  const fuelPct = Math.max(0, Math.min(100, Math.round(s.fuel)));

  return (
    <div className="easter-overlay" role="dialog" aria-modal="true" aria-label="Floppy Rescue easter egg">
      <div className="easter-frame">
        <div className="easter-titlebar">
          <span>** FLOPPY RESCUE **</span>
          <div className="easter-titlebar-actions">
            {screen === "game" && status === "playing" && (
              <button
                type="button"
                className="easter-pause-btn"
                onClick={() => {
                  stateRef.current = togglePause(stateRef.current);
                  forceRender((n) => n + 1);
                }}
                aria-label="Pause (P)"
              >
                II
              </button>
            )}
            <button type="button" className="easter-close" onClick={exit} aria-label="Close (Escape)">
              X
            </button>
          </div>
        </div>
        {!calmAcknowledged ? (
          <div className="easter-calm-notice">
            <p>
              Your system prefers reduced motion. Floppy Rescue involves continuous flight and scrolling
              scenery -- it isn&apos;t a good fit for a fully static mode, so proceed only if you&apos;re okay
              with that, or close this instead.
            </p>
            <div className="easter-calm-actions">
              <button type="button" className="btn btn-primary" onClick={() => setCalmAcknowledged(true)}>
                Play anyway
              </button>
              <button type="button" className="btn" onClick={exit}>
                Close
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="easter-canvas-wrap">
              <canvas ref={canvasRef} width={WORLD_W} height={WORLD_H} className="easter-canvas" aria-label="Game screen" />
              {screen === "title" && (
                <div className="easter-title-overlay">
                  <p className="easter-title-name">FLOPPY RESCUE</p>
                  <p className="easter-title-sub">HI {highScore}</p>
                  <button type="button" className="btn btn-primary" onClick={startGame}>
                    Press start
                  </button>
                  <p className="easter-help">
                    Arrows/WASD fly, land gently to board/unload, P pauses, Escape exits. Gamepad supported.
                  </p>
                </div>
              )}
              {screen === "game" && status === "levelIntro" && (
                <div className="easter-level-card">
                  <p>{s.levelText}</p>
                </div>
              )}
            </div>
            {screen === "game" && status !== "levelIntro" && (
              <div className="easter-hud easter-hud-rescue">
                <span>SCORE {Math.floor(s.score)}</span>
                <span>HI {Math.floor(highScore)}</span>
                <span>LV {s.level}</span>
                <span>
                  ON BOARD {s.onBoard}/{CAPACITY}
                </span>
                <span>FUEL {fuelPct}%</span>
                <span>LIVES {"* ".repeat(Math.max(0, s.lives)).trim() || "-"}</span>
              </div>
            )}
            {screen === "game" && status === "paused" && (
              <div className="easter-modal">
                <p>PAUSED</p>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    stateRef.current = togglePause(stateRef.current);
                    forceRender((n) => n + 1);
                  }}
                >
                  Resume
                </button>
              </div>
            )}
            {screen === "game" && status === "gameover" && (
              <div className="easter-modal">
                <p>GAME OVER</p>
                <p>SCORE {Math.floor(s.score)}</p>
                <p className="easter-ready">
                  READY.
                  <span className="easter-cursor" aria-hidden="true">
                    &#9608;
                  </span>
                </p>
                <button type="button" className="btn btn-primary" onClick={restart}>
                  Play again
                </button>
              </div>
            )}
            {screen === "game" && status !== "levelIntro" && (
              <div className={`easter-touch-controls easter-touch-rescue${forceTouch ? " force-show" : ""}`} aria-hidden={false}>
                <VirtualStick inputRef={inputRef} />
                <button
                  type="button"
                  className="easter-touch-btn easter-touch-lift"
                  onPointerDown={() => (inputRef.current.up = true)}
                  onPointerUp={() => (inputRef.current.up = false)}
                  onPointerLeave={() => (inputRef.current.up = false)}
                  aria-label="Lift"
                >
                  LIFT
                </button>
              </div>
            )}
            {screen === "game" && status !== "levelIntro" && (
              <p className="easter-help">Arrows/WASD fly, land gently to board/unload, P pauses, Escape exits.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function VirtualStick({ inputRef }: { inputRef: React.MutableRefObject<GameInput> }) {
  const baseRef = useRef<HTMLDivElement | null>(null);
  const [knob, setKnob] = useState({ x: 0, y: 0 });
  const activeRef = useRef(false);

  function updateFromPointer(clientX: number, clientY: number) {
    const base = baseRef.current;
    if (!base) return;
    const rect = base.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    const radius = rect.width / 2;
    const dist = Math.min(radius, Math.hypot(dx, dy));
    const angle = Math.atan2(dy, dx);
    const kx = Math.cos(angle) * dist;
    const ky = Math.sin(angle) * dist;
    setKnob({ x: kx, y: ky });
    const deadzone = radius * 0.3;
    inputRef.current.left = dx < -deadzone;
    inputRef.current.right = dx > deadzone;
    inputRef.current.up = dy < -deadzone;
    inputRef.current.down = dy > deadzone;
  }

  function reset() {
    activeRef.current = false;
    setKnob({ x: 0, y: 0 });
    inputRef.current.left = false;
    inputRef.current.right = false;
    inputRef.current.up = false;
    inputRef.current.down = false;
  }

  return (
    <div
      ref={baseRef}
      className="easter-stick-base"
      onPointerDown={(e) => {
        activeRef.current = true;
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        updateFromPointer(e.clientX, e.clientY);
      }}
      onPointerMove={(e) => {
        if (!activeRef.current) return;
        updateFromPointer(e.clientX, e.clientY);
      }}
      onPointerUp={reset}
      onPointerCancel={reset}
      onPointerLeave={() => {
        if (activeRef.current) reset();
      }}
      role="slider"
      aria-label="Flight stick"
      aria-valuetext="drag to fly"
      aria-valuenow={0}
    >
      <div className="easter-stick-knob" style={{ transform: `translate(${knob.x}px, ${knob.y}px)` }} />
    </div>
  );
}

// --- background: sky gradient + clouds/stars parallax + ground detail -----------------------------
// Clouds/stars are a small repeating pattern (not per-level arrays) so they look right at any level
// width: draw the pattern once per PERIOD-px tile, shifted by camera position * a parallax factor.
const SKY_PATTERN_PERIOD = 140;
const SKY_PATTERN: Array<{ dx: number; dy: number; w: number; h: number; kind: "cloud" | "star" }> = [
  { dx: 14, dy: 18, w: 16, h: 5, kind: "cloud" },
  { dx: 70, dy: 30, w: 12, h: 4, kind: "cloud" },
  { dx: 40, dy: 8, w: 2, h: 2, kind: "star" },
  { dx: 100, dy: 14, w: 2, h: 2, kind: "star" },
  { dx: 118, dy: 44, w: 2, h: 2, kind: "star" },
];

function drawBackground(ctx: CanvasRenderingContext2D, cameraX: number, reducedMotion: boolean): void {
  const grad = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  grad.addColorStop(0, "#1c1650");
  grad.addColorStop(1, "#302870");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, WORLD_W, GROUND_Y);

  const parallax = reducedMotion ? 0 : cameraX * 0.25;
  const startTile = Math.floor(parallax / SKY_PATTERN_PERIOD) - 1;
  const endTile = Math.floor((parallax + WORLD_W) / SKY_PATTERN_PERIOD) + 1;
  for (let tile = startTile; tile <= endTile; tile++) {
    const tileX = tile * SKY_PATTERN_PERIOD - parallax;
    for (const item of SKY_PATTERN) {
      const x = tileX + item.dx;
      const y = item.dy;
      if (x + item.w < 0 || x > WORLD_W) continue;
      ctx.fillStyle = item.kind === "cloud" ? "#3f3690" : "#8b7cd8";
      ctx.fillRect(Math.round(x), y, item.w, item.h);
      if (item.kind === "cloud") ctx.fillRect(Math.round(x) + 4, y - 2, item.w - 8, 3);
    }
  }

  // ground band with a simple grass-tick texture that scrolls at full camera speed (drawn in the
  // camera-translated block by the caller, this function only paints the sky).
}

function drawGround(ctx: CanvasRenderingContext2D, cameraX: number, levelW: number): void {
  ctx.fillStyle = "#3a3184";
  ctx.fillRect(0, GROUND_Y, WORLD_W, WORLD_H - GROUND_Y);
  ctx.strokeStyle = "#8b7cd8";
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y);
  ctx.lineTo(levelW, GROUND_Y);
  ctx.stroke();
  ctx.fillStyle = "#4a3fa0";
  const start = Math.floor(cameraX / 8) * 8;
  for (let x = start; x < cameraX + WORLD_W; x += 8) {
    ctx.fillRect(x + 2, GROUND_Y + 3, 2, 2);
  }
}

// --- Disk Box (home base): a small building, not just a strip -------------------------------------
function drawDiskBox(ctx: CanvasRenderingContext2D, x: number, padW: number): void {
  const baseY = GROUND_Y;
  const wallW = padW - 12;
  const wallX = x + 6;
  const wallH = 26;
  const wallY = baseY - wallH;
  // walls
  ctx.fillStyle = "#3a3184";
  ctx.fillRect(wallX, wallY, wallW, wallH);
  // roof
  ctx.fillStyle = "#8b7cd8";
  ctx.beginPath();
  ctx.moveTo(wallX - 4, wallY);
  ctx.lineTo(wallX + wallW / 2, wallY - 12);
  ctx.lineTo(wallX + wallW + 4, wallY);
  ctx.closePath();
  ctx.fill();
  // door
  ctx.fillStyle = "#241e5c";
  ctx.fillRect(wallX + wallW / 2 - 4, baseY - 12, 8, 12);
  // window
  ctx.fillStyle = "#5cff8a";
  ctx.fillRect(wallX + 4, wallY + 6, 5, 5);
  ctx.fillRect(wallX + wallW - 9, wallY + 6, 5, 5);
  // sign board on a post
  ctx.fillStyle = "#241e5c";
  ctx.fillRect(x + padW / 2 - 1, wallY - 20, 2, 8);
  ctx.fillStyle = "#e4e0fb";
  ctx.fillRect(x + padW / 2 - 20, wallY - 24, 40, 9);
  ctx.fillStyle = "#241e5c";
  ctx.font = "7px monospace";
  ctx.textAlign = "center";
  ctx.fillText("DISK BOX", x + padW / 2, wallY - 17);
  ctx.textAlign = "left";
  // landing pad markings
  ctx.fillStyle = "#5cff8a";
  ctx.fillRect(x, baseY - 3, padW, 3);
}

function drawFarmSign(ctx: CanvasRenderingContext2D, x: number, padW: number, topY: number): void {
  ctx.fillStyle = "#e4e0fb";
  ctx.fillRect(x + padW / 2 - 26, topY - 10, 52, 9);
  ctx.fillStyle = "#241e5c";
  ctx.font = "7px monospace";
  ctx.textAlign = "center";
  ctx.fillText("SERVER FARM", x + padW / 2, topY - 3);
  ctx.textAlign = "left";
  ctx.fillStyle = "#8b7cd8";
  ctx.fillRect(x, GROUND_Y - 3, padW, 3);
}

// --- in-canvas HUD + minimap -----------------------------------------------------------------------
function drawHud(ctx: CanvasRenderingContext2D, state: GameState, highScore: number, fuelPct: number): void {
  ctx.save();
  ctx.font = "7px monospace";
  ctx.textBaseline = "top";
  const lines = [
    `SCORE ${Math.floor(state.score)}  HI ${Math.floor(highScore)}`,
    `LV ${state.level}  ON BOARD ${state.onBoard}/${CAPACITY}  LIVES ${state.lives}`,
  ];
  const boxW = 150;
  const boxH = 18;
  ctx.fillStyle = "rgba(36, 30, 92, 0.72)";
  ctx.fillRect(2, 2, boxW, boxH);
  ctx.fillStyle = "#e4e0fb";
  lines.forEach((line, i) => ctx.fillText(line, 5, 4 + i * 8));

  // fuel bar, drawn directly so its fill is always visibly correct (a real percentage-width bar,
  // not a shared component whose contrast can drift against this canvas's own colour scheme).
  const barX = 2;
  const barY = boxH + 5;
  const barW = 60;
  const barH = 5;
  ctx.fillStyle = "#241e5c";
  ctx.fillRect(barX, barY, barW, barH);
  const fillColor = fuelPct < 25 ? "#ff8a8a" : fuelPct < 50 ? "#f4cf3c" : "#5cff8a";
  ctx.fillStyle = fillColor;
  ctx.fillRect(barX, barY, Math.max(0, Math.round((barW * fuelPct) / 100)), barH);
  ctx.strokeStyle = "#8b7cd8";
  ctx.lineWidth = 1;
  ctx.strokeRect(barX + 0.5, barY + 0.5, barW - 1, barH - 1);
  ctx.fillStyle = "#e4e0fb";
  ctx.fillText(`FUEL ${fuelPct}%`, barX + barW + 4, barY - 1);

  // distance minimap: a thin strip across the top-right showing progress along the level, with
  // markers for home/farm and a dot for the player.
  const mmX = WORLD_W - 96;
  const mmY = 3;
  const mmW = 92;
  const mmH = 4;
  ctx.fillStyle = "rgba(36, 30, 92, 0.72)";
  ctx.fillRect(mmX - 3, mmY - 3, mmW + 6, mmH + 14);
  ctx.strokeStyle = "#8b7cd8";
  ctx.strokeRect(mmX + 0.5, mmY + 0.5, mmW - 1, mmH - 1);
  const frac = (v: number) => Math.max(0, Math.min(1, v / state.levelW));
  ctx.fillStyle = "#5cff8a";
  ctx.fillRect(mmX + frac(state.homeX) * mmW - 1, mmY - 1, 2, mmH + 2);
  ctx.fillStyle = "#ff8a8a";
  ctx.fillRect(mmX + frac(state.farmX) * mmW - 1, mmY - 1, 2, mmH + 2);
  ctx.fillStyle = "#e4e0fb";
  ctx.fillRect(mmX + frac(state.playerX) * mmW - 1, mmY - 1, 2, mmH + 2);
  ctx.font = "6px monospace";
  ctx.fillStyle = "#a89fe0";
  ctx.fillText("MAP", mmX, mmY + mmH + 2);
  ctx.restore();
}

// --- player helicopter, drawn from primitive rects (see file header) -------------------------------
function drawHeli(ctx: CanvasRenderingContext2D, x: number, y: number, tilt: number, invuln: boolean, rotorFrame: number): void {
  ctx.save();
  ctx.translate(x + 13, y + 9);
  ctx.rotate(tilt);
  const body = invuln ? "#f4cf3c" : "#5cff8a";
  const dark = "#241e5c";
  const light = "#e4e0fb";
  ctx.fillStyle = dark;
  ctx.fillRect(-13, -1, 12, 3); // tail boom
  ctx.fillRect(-13, -4, 3, 8); // tail fin
  ctx.fillStyle = body;
  ctx.fillRect(-2, -5, 13, 11); // cabin
  ctx.fillStyle = light;
  ctx.fillRect(3, -3, 6, 5); // cockpit window
  ctx.fillStyle = dark;
  ctx.fillRect(-1, 5, 11, 1); // skid strut
  ctx.fillRect(-1, 6, 3, 2);
  ctx.fillRect(7, 6, 3, 2);
  ctx.fillRect(3, -7, 2, 3); // rotor mast
  ctx.fillStyle = light;
  if (rotorFrame === 0) ctx.fillRect(-10, -8, 26, 2);
  else ctx.fillRect(-2, -8, 10, 2);
  ctx.restore();
}

function draw(
  canvas: HTMLCanvasElement | null,
  state: GameState,
  particles: Particle[],
  shake: ShakeState | null,
  reducedMotion: boolean,
  screen: "title" | "game",
  highScore: number,
): void {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;

  const camX = state.cameraX;
  ctx.save();
  const [sx, sy] = reducedMotion ? [0, 0] : shakeOffset(shake);
  ctx.translate(sx, sy);

  drawBackground(ctx, camX, reducedMotion);

  ctx.save();
  ctx.translate(-camX, 0);

  drawGround(ctx, camX, state.levelW);
  drawDiskBox(ctx, state.homeX, HOME_PAD_W);

  // farm: rack "building" (racks tiled two rows tall so it reads as a structure) + sign + fire
  for (let x = state.farmX; x < state.farmX + FARM_PAD_W; x += 12) {
    drawSprite(ctx, RACK_UNIT_SPRITE, RACK_PALETTE, x, GROUND_Y - 16, SPRITE_SCALE);
  }
  drawFarmSign(ctx, state.farmX, FARM_PAD_W, GROUND_Y - 16);
  for (const cell of state.fireCells) {
    if (cell.intensity <= 0) continue;
    const frame = FLAME_SPRITES[Math.floor(state.t / 140) % FLAME_SPRITES.length]!;
    const flicker = reducedMotion ? FLAME_SPRITES[0]! : frame;
    ctx.globalAlpha = Math.min(1, cell.intensity + 0.15);
    drawSprite(ctx, flicker, FLAME_PALETTE, cell.x + cell.w / 2 - 3, GROUND_Y - 22, SPRITE_SCALE);
    ctx.globalAlpha = 1;
  }

  // floppy walkers waiting at the farm (2-frame walk/wave animation)
  const floppyFrame = reducedMotion ? 0 : Math.floor(state.t / 220) % FLOPPY_WALKER_SPRITES.length;
  for (const f of state.floppies) {
    if (!f.alive || f.boarded) continue;
    drawSprite(ctx, FLOPPY_WALKER_SPRITES[floppyFrame]!, FLOPPY_PALETTE, f.x - 4, f.y - 10, SPRITE_SCALE);
  }

  // debris
  for (const d of state.debris) {
    drawSprite(ctx, DEBRIS_SPRITE, DEBRIS_PALETTE, d.x - 2, d.y - 2, SPRITE_SCALE);
  }

  // drone + its bullets
  if (state.drone) drawSprite(ctx, DRONE_SPRITE, DRONE_PALETTE, state.drone.x - 5, state.drone.y - 5, SPRITE_SCALE);
  ctx.fillStyle = "#ff8a8a";
  for (const b of state.droneBullets) ctx.fillRect(b.x - 2, b.y - 2, 4, 4);

  // explosion particles
  for (const p of particles) {
    const alpha = Math.max(0, p.lifeMs / p.maxLifeMs);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
  }
  ctx.globalAlpha = 1;

  // player helicopter, tilted toward direction of travel, blinking while invulnerable
  if (screen === "game" || screen === "title") {
    const blinkOff = !reducedMotion && state.invulnMs > 0 && Math.floor(state.t / 90) % 2 === 0;
    if (!blinkOff) {
      const tilt = playerTilt(state.playerVx);
      const rotorFrame = reducedMotion ? 0 : Math.floor(state.t / 55) % 2;
      drawHeli(ctx, state.playerX, state.playerY, tilt, state.invulnMs > 0, rotorFrame);
    }
  }

  ctx.restore(); // undo camera translate

  if (screen === "game") drawHud(ctx, state, highScore, Math.max(0, Math.min(100, Math.round(state.fuel))));

  ctx.restore(); // undo shake translate
}
