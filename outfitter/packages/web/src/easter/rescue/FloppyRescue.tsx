// "FLOPPY RESCUE" -- the main easter-egg game, inspired by (not a copy of) Choplifter: fly a pixel
// helicopter from the Disk Box (home base) out over a scrolling landscape to a burning server farm,
// land, let little Floppy characters board (capacity 8), then fly them home to unload for score.
// No shared names, art, sound or level layout with Choplifter -- see
// docs/reports/easter-egg-research.md for the design rationale.
//
// Self-contained: this component (plus engine.ts/sprites.ts/sound.ts) is the entire feature
// surface, always loaded via a dynamic import (see EasterEggRoot.tsx) so it costs nothing in the
// main bundle until triggered.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  attractInput,
  CAPACITY,
  createInitialState,
  createLevelState,
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
  FLOPPY_WALKER_PALETTE,
  FLOPPY_WALKER_SPRITE,
  HELI_PALETTE,
  HELI_PALETTE_INVULN,
  HELI_SPRITE,
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
      const merged: GameInput = {
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
        const airborne = after.playerY + 16 < GROUND_Y - 1;
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
    [screen, reducedMotion],
  );

  const onRender = useCallback(() => {
    draw(canvasRef.current, stateRef.current, particlesRef.current, shakeRef.current, reducedMotion, screen);
    forceRender((n) => (n + 1) % 1000000);
  }, [reducedMotion, screen]);
  useFixedStepLoop(onStep, onRender, loopActive);

  function restart() {
    stopRotor();
    startGame();
  }

  const s = stateRef.current;
  const status = s.status;
  const fuelPct = Math.round(s.fuel);

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
                <span className="easter-fuel">
                  FUEL
                  <span className="meter" aria-hidden="true">
                    <span
                      className={`meter-fill${fuelPct < 30 ? " meter-danger" : fuelPct < 55 ? " meter-warn" : ""}`}
                      style={{ width: `${fuelPct}%` }}
                    />
                  </span>
                </span>
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
              <div className="easter-touch-controls easter-touch-rescue" aria-hidden={false}>
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

function drawLandscape(ctx: CanvasRenderingContext2D, cameraX: number, reducedMotion: boolean): void {
  ctx.fillStyle = "#241e5c";
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  // distant hills (slow parallax) + ground strip
  const layers: Array<{ factor: number; spacing: number; color: string; y: number; h: number }> = [
    { factor: 0.2, spacing: 120, color: "#2c2566", y: WORLD_H - 140, h: 90 },
    { factor: 0.5, spacing: 70, color: "#332b70", y: WORLD_H - 90, h: 40 },
  ];
  for (const layer of layers) {
    const offset = reducedMotion ? 0 : (cameraX * layer.factor) % layer.spacing;
    ctx.fillStyle = layer.color;
    for (let x = -offset - layer.spacing; x < WORLD_W + layer.spacing; x += layer.spacing) {
      ctx.beginPath();
      ctx.moveTo(x, layer.y + layer.h);
      ctx.lineTo(x + layer.spacing / 2, layer.y);
      ctx.lineTo(x + layer.spacing, layer.y + layer.h);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.fillStyle = "#3a3184";
  ctx.fillRect(0, GROUND_Y, WORLD_W, WORLD_H - GROUND_Y);
  ctx.strokeStyle = "#8b7cd8";
  ctx.beginPath();
  ctx.moveTo(0, GROUND_Y);
  ctx.lineTo(WORLD_W, GROUND_Y);
  ctx.stroke();
}

function draw(
  canvas: HTMLCanvasElement | null,
  state: GameState,
  particles: Particle[],
  shake: ShakeState | null,
  reducedMotion: boolean,
  screen: "title" | "game",
): void {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;

  const camX = state.cameraX;
  ctx.save();
  const [sx, sy] = reducedMotion ? [0, 0] : shakeOffset(shake);
  ctx.translate(sx, sy);

  drawLandscape(ctx, camX, reducedMotion);

  ctx.save();
  ctx.translate(-camX, 0);

  // home pad (Disk Box)
  ctx.fillStyle = "#5cff8a";
  ctx.fillRect(state.homeX, GROUND_Y - 4, HOME_PAD_W, 4);
  ctx.fillStyle = "#e4e0fb";
  ctx.font = "10px monospace";
  ctx.fillText("DISK BOX", state.homeX + 8, GROUND_Y - 10);

  // farm pad + rack units + fire
  ctx.fillStyle = "#8b7cd8";
  ctx.fillRect(state.farmX, GROUND_Y - 4, FARM_PAD_W, 4);
  for (let x = state.farmX; x < state.farmX + FARM_PAD_W; x += 26) {
    drawSprite(ctx, RACK_UNIT_SPRITE, RACK_PALETTE, x, GROUND_Y - 60, SPRITE_SCALE);
  }
  for (const cell of state.fireCells) {
    if (cell.intensity <= 0) continue;
    const frame = FLAME_SPRITES[Math.floor(state.t / 120) % FLAME_SPRITES.length]!;
    const flicker = reducedMotion ? FLAME_SPRITES[0]! : frame;
    ctx.globalAlpha = Math.min(1, cell.intensity + 0.15);
    drawSprite(ctx, flicker, FLAME_PALETTE, cell.x + cell.w / 2 - 6, GROUND_Y - 66, SPRITE_SCALE);
    ctx.globalAlpha = 1;
  }

  // floppy walkers waiting at the farm
  for (const f of state.floppies) {
    if (!f.alive || f.boarded) continue;
    drawSprite(ctx, FLOPPY_WALKER_SPRITE, FLOPPY_WALKER_PALETTE, f.x - 5, f.y - 14, SPRITE_SCALE);
  }

  // debris
  for (const d of state.debris) {
    drawSprite(ctx, DEBRIS_SPRITE, DEBRIS_PALETTE, d.x - 4, d.y - 4, SPRITE_SCALE);
  }

  // drone + its bullets
  if (state.drone) drawSprite(ctx, DRONE_SPRITE, DRONE_PALETTE, state.drone.x - 9, state.drone.y - 9, SPRITE_SCALE);
  ctx.fillStyle = "#ff8a8a";
  for (const b of state.droneBullets) ctx.fillRect(b.x - 3, b.y - 3, 6, 6);

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
      const cx = state.playerX + 15;
      const cy = state.playerY + 9;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(tilt);
      ctx.translate(-15, -9);
      drawSprite(ctx, HELI_SPRITE, state.invulnMs > 0 ? HELI_PALETTE_INVULN : HELI_PALETTE, 0, 0, SPRITE_SCALE);
      ctx.restore();
    }
  }

  ctx.restore(); // undo camera translate
  ctx.restore(); // undo shake translate
}
