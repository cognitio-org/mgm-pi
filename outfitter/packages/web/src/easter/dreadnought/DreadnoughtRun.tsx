// "DREADNOUGHT RUN" -- a small Uridium-inspired horizontal scrolling shooter easter egg. Skim a
// ship low over a giant data-center dreadnought, dodge server racks, shoot turrets and drones,
// grab stray Floppies. Not a copy of Uridium: no shared names, art, sound, or level layout -- see
// docs/reports/easter-egg-research.md for the design rationale.
//
// Self-contained: this component (plus engine.ts/sprites.ts/sound.ts) is the entire feature
// surface. It is always loaded via a dynamic import (see EasterEggRoot.tsx) so it costs nothing in
// the main bundle until triggered.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  attractInput,
  createInitialState,
  PLAYER_H,
  PLAYER_MIN_Y,
  PLAYER_MAX_Y,
  PLAYER_X,
  step,
  togglePause,
  WORLD_H,
  WORLD_W,
  type GameEvent,
  type GameInput,
  type GameState,
} from "./engine.ts";
import { playExplosion, playGameOver, playHit, playLaser, playPickup } from "./sound.ts";
import { readHighScore, writeHighScoreIfBetter } from "../shared/highscore.ts";
import { usesReducedMotion } from "../shared/motion.ts";
import { useFixedStepLoop } from "../shared/fixedStep.ts";
import { readGamepadButtons, readGamepadDirection } from "../shared/gamepad.ts";
import { spawnExplosionParticles, stepParticles, stepShake, triggerShake, shakeOffset, type Particle, type ShakeState } from "../shared/particles.ts";
import { drawSprite } from "../shared/pixelSprite.ts";
import {
  DRONE_PALETTE,
  DRONE_SPRITE,
  FLOPPY_PALETTE,
  FLOPPY_SPRITE,
  RACK_PALETTE,
  RACK_UNIT_SPRITE,
  SHIP_PALETTE_INVULN,
  SHIP_PALETTE_NORMAL,
  SHIP_SPRITE,
  SPRITE_SCALE,
  TURRET_PALETTE,
  TURRET_PALETTE_DAMAGED,
  TURRET_SPRITE,
} from "./sprites.ts";

interface DreadnoughtRunProps {
  onClose: () => void;
}

function readQueryFlag(name: string): boolean {
  try {
    return new URLSearchParams(window.location.search).get(name) === "1";
  } catch {
    return false;
  }
}

export function DreadnoughtRun({ onClose }: DreadnoughtRunProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<GameState>(createInitialState(Date.now() & 0xffffffff));
  const inputRef = useRef<GameInput>({ up: false, down: false, firing: false });
  const particlesRef = useRef<Particle[]>([]);
  const shakeRef = useRef<ShakeState | null>(null);
  const lastPauseButtonRef = useRef(false);
  const [, forceRender] = useState(0);
  const [highScore, setHighScore] = useState(() => readHighScore("dreadnought"));
  const reducedMotion = useMemo(() => usesReducedMotion(), []);
  const [calmAcknowledged, setCalmAcknowledged] = useState(!reducedMotion);
  const [screen, setScreen] = useState<"title" | "game">("title");
  const autoDemo = useMemo(() => readQueryFlag("demo"), []);
  const forceTouch = useMemo(() => readQueryFlag("touch"), []);

  const exit = useCallback(() => {
    const s = stateRef.current;
    writeHighScoreIfBetter("dreadnought", s.score);
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
      if (e.key === " " || e.key === "ArrowRight") {
        e.preventDefault();
        inputRef.current.firing = true;
      }
    }
    function onKeyUp(e: KeyboardEvent) {
      if (e.key === "ArrowUp" || e.key === "w" || e.key === "W") inputRef.current.up = false;
      if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") inputRef.current.down = false;
      if (e.key === " " || e.key === "ArrowRight") inputRef.current.firing = false;
    }
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [exit, screen, calmAcknowledged]);

  // auto-start the demo for headless screenshots/video (?demo=1)
  useEffect(() => {
    if (autoDemo && screen === "title" && calmAcknowledged) startGame();
    // only on mount / when calm notice clears -- not a loop, startGame flips `screen` away from
    // "title" so this effect won't re-fire.
  }, [autoDemo, calmAcknowledged]);

  function applyEvents(events: GameEvent[]) {
    for (const ev of events) {
      if (ev.type === "obstacleDestroyed") {
        if (!reducedMotion) particlesRef.current = particlesRef.current.concat(spawnExplosionParticles(ev.x, ev.y, 10, "#f4cf3c"));
        if (!reducedMotion) shakeRef.current = triggerShake(4);
      } else if (ev.type === "playerHit") {
        if (!reducedMotion) particlesRef.current = particlesRef.current.concat(spawnExplosionParticles(ev.x, ev.y, 14, "#ff8a8a"));
        if (!reducedMotion) shakeRef.current = triggerShake(7);
      }
    }
  }

  // --- fixed-timestep game loop (title attract-mode or real play) ---
  const loopActive = calmAcknowledged;
  const onStep = useCallback(
    (dtMs: number) => {
      if (screen === "title") {
        const before = stateRef.current;
        const botInput = attractInput(before.t);
        let after = step(before, botInput, dtMs);
        if (after.status === "gameover") after = createInitialState((Date.now() + before.t) & 0xffffffff);
        stateRef.current = after;
        particlesRef.current = stepParticles(particlesRef.current, dtMs);
        return;
      }
      const gp = readGamepadDirection();
      const gpButtons = readGamepadButtons();
      // ?demo=1 keeps the attract-mode autopilot flying even past the title screen, so a headless
      // screenshot/video of "mid-game" shows real action instead of an idle, unpiloted ship.
      const merged: GameInput = autoDemo
        ? attractInput(stateRef.current.t)
        : {
            up: inputRef.current.up || gp.up,
            down: inputRef.current.down || gp.down,
            firing: inputRef.current.firing || gpButtons.fire,
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

      if (after.status === "playing") {
        if (after.bullets.length > before.bullets.length) playLaser();
        if (after.score > before.score) {
          const gainedFromKill = after.obstacles.length < before.obstacles.length;
          if (gainedFromKill) playExplosion();
          else playPickup();
        }
        if (after.invulnMs > 0 && before.invulnMs === 0) playHit();
        applyEvents(after.events);
      } else if (after.status === "gameover" && before.status === "playing") {
        applyEvents(after.events);
        playGameOver();
        setHighScore(writeHighScoreIfBetter("dreadnought", after.score));
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
    startGame();
  }

  const status = stateRef.current.status;

  return (
    <div className="easter-overlay" role="dialog" aria-modal="true" aria-label="Dreadnought Run easter egg">
      <div className="easter-frame">
        <div className="easter-titlebar">
          <span>** DREADNOUGHT RUN **</span>
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
              Your system prefers reduced motion. Dreadnought Run is a fast-scrolling game with continuous
              motion -- it isn&apos;t a good fit for a fully static mode, so proceed only if you&apos;re okay
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
              <canvas
                ref={canvasRef}
                width={WORLD_W}
                height={WORLD_H}
                className="easter-canvas"
                aria-label="Game screen"
              />
              {screen === "title" && (
                <div className="easter-title-overlay">
                  <p className="easter-title-name">DREADNOUGHT RUN</p>
                  <p className="easter-title-sub">HI {highScore}</p>
                  <button type="button" className="btn btn-primary" onClick={startGame}>
                    Press start
                  </button>
                  <p className="easter-help">Arrows/WASD move, Space fires, P pauses, Escape exits. Gamepad supported.</p>
                </div>
              )}
            </div>
            {screen === "game" && (
              <div className="easter-hud">
                <span>SCORE {Math.floor(stateRef.current.score)}</span>
                <span>HI {Math.floor(highScore)}</span>
                <span>LIVES {"* ".repeat(Math.max(0, stateRef.current.lives)).trim() || "-"}</span>
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
                <p>SCORE {Math.floor(stateRef.current.score)}</p>
                <button type="button" className="btn btn-primary" onClick={restart}>
                  Play again
                </button>
              </div>
            )}
            {screen === "game" && (
              <div className={`easter-touch-controls${forceTouch ? " force-show" : ""}`} aria-hidden={false}>
                <button
                  type="button"
                  className="easter-touch-btn"
                  onPointerDown={() => (inputRef.current.up = true)}
                  onPointerUp={() => (inputRef.current.up = false)}
                  onPointerLeave={() => (inputRef.current.up = false)}
                  aria-label="Move up"
                >
                  UP
                </button>
                <button
                  type="button"
                  className="easter-touch-btn"
                  onPointerDown={() => (inputRef.current.down = true)}
                  onPointerUp={() => (inputRef.current.down = false)}
                  onPointerLeave={() => (inputRef.current.down = false)}
                  aria-label="Move down"
                >
                  DOWN
                </button>
                <button
                  type="button"
                  className="easter-touch-btn easter-touch-fire"
                  onPointerDown={() => (inputRef.current.firing = true)}
                  onPointerUp={() => (inputRef.current.firing = false)}
                  onPointerLeave={() => (inputRef.current.firing = false)}
                  aria-label="Fire"
                >
                  FIRE
                </button>
              </div>
            )}
            {screen === "game" && <p className="easter-help">Arrows/WASD move, Space fires, P pauses, Escape exits.</p>}
          </>
        )}
      </div>
    </div>
  );
}

// The dreadnought's actual hull, not a bare grid: three depth layers scrolling at different
// fractions of world speed. Farthest = distant tower silhouettes along the horizon; mid = hull
// panelling with rivets and vent slits; nearest = a runway-light stripe along the top/bottom edges,
// like guide lighting skimmed at speed. Tower heights are a deterministic hash of their tile index
// (no RNG/state needed) so the same stretch of hull always looks the same.
function drawHull(ctx: CanvasRenderingContext2D, distance: number, reducedMotion: boolean): void {
  const spacing1 = 70;
  const offset1 = reducedMotion ? 0 : distance * 0.12 % spacing1;
  ctx.fillStyle = "#2c2566";
  for (let x = -offset1 - spacing1; x < WORLD_W + spacing1; x += spacing1) {
    const i = Math.round((x + offset1) / spacing1);
    const h = 24 + ((Math.abs(i * 2654435761) >>> 0) % 34);
    const rx = Math.round(x);
    ctx.fillRect(rx, WORLD_H - h, 12, h);
    ctx.fillRect(rx + 4, WORLD_H - h - 5, 4, 5); // antenna cap
  }

  const spacing2 = 36;
  const offset2 = reducedMotion ? 0 : distance * 0.4 % spacing2;
  ctx.strokeStyle = "#3f3690";
  ctx.lineWidth = 1;
  for (let x = -offset2; x < WORLD_W; x += spacing2) {
    const rx = Math.round(x);
    ctx.beginPath();
    ctx.moveTo(rx, 0);
    ctx.lineTo(rx, WORLD_H);
    ctx.stroke();
    ctx.fillStyle = "#3f3690";
    ctx.fillRect(rx + 6, 14, 2, 2); // rivet
    ctx.fillRect(rx + 6, WORLD_H - 20, 2, 2);
    ctx.fillStyle = "#1c1650";
    ctx.fillRect(rx + 14, WORLD_H / 2 - 2, 10, 3); // vent slit
  }

  const spacing3 = 16;
  const offset3 = reducedMotion ? 0 : distance % spacing3;
  ctx.fillStyle = "#5a4fc0";
  for (let x = -offset3; x < WORLD_W; x += spacing3) {
    const rx = Math.round(x);
    ctx.fillRect(rx, 6, 8, 2); // runway lighting, top
    ctx.fillRect(rx, WORLD_H - 8, 8, 2); // runway lighting, bottom
  }
}

// Compact C64-style HUD drawn directly onto the canvas -- inside the game frame, not only in the
// HTML footer strip below it (that larger, accessible version stays too).
function drawHud(ctx: CanvasRenderingContext2D, state: GameState, highScore: number): void {
  ctx.save();
  ctx.font = "7px monospace";
  ctx.textBaseline = "top";
  const boxW = 118;
  const boxH = 18;
  ctx.fillStyle = "rgba(36, 30, 92, 0.72)";
  ctx.fillRect(2, 2, boxW, boxH);
  ctx.fillStyle = "#e4e0fb";
  ctx.fillText(`SCORE ${Math.floor(state.score)}  HI ${Math.floor(highScore)}`, 5, 4);
  ctx.fillText(`LIVES ${state.lives}  DIST ${Math.floor(state.distance)}`, 5, 12);
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

  ctx.save();
  const [sx, sy] = reducedMotion ? [0, 0] : shakeOffset(shake);
  ctx.translate(sx, sy);

  ctx.fillStyle = "#241e5c";
  ctx.fillRect(-8, -8, WORLD_W + 16, WORLD_H + 16);

  drawHull(ctx, state.distance, reducedMotion);

  // obstacles, pixel-art sprites
  for (const o of state.obstacles) {
    if (o.kind === "rack") {
      let ty = o.y;
      const [, unitH] = [0, RACK_UNIT_SPRITE.length * SPRITE_SCALE];
      while (ty < o.y + o.h) {
        drawSprite(ctx, RACK_UNIT_SPRITE, RACK_PALETTE, o.x, ty, SPRITE_SCALE);
        ty += unitH;
      }
    } else if (o.kind === "turret") {
      drawSprite(ctx, TURRET_SPRITE, o.hp > 1 ? TURRET_PALETTE : TURRET_PALETTE_DAMAGED, o.x, o.y, SPRITE_SCALE);
    } else {
      drawSprite(ctx, DRONE_SPRITE, DRONE_PALETTE, o.x, o.y, SPRITE_SCALE);
    }
  }

  // pickups (floppies)
  for (const p of state.pickups) {
    drawSprite(ctx, FLOPPY_SPRITE, FLOPPY_PALETTE, p.x - 5, p.y - 5, SPRITE_SCALE);
  }

  // bullets
  ctx.fillStyle = "#e4e0fb";
  for (const b of state.bullets) ctx.fillRect(b.x - 3, b.y - 1.5, 6, 3);
  ctx.fillStyle = "#ff8a8a";
  for (const b of state.enemyBullets) ctx.fillRect(b.x - 3, b.y - 1.5, 6, 3);

  // explosion particles
  for (const p of particles) {
    const alpha = Math.max(0, p.lifeMs / p.maxLifeMs);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
  }
  ctx.globalAlpha = 1;

  // player ship (blinks while invulnerable, unless reduced motion -- then a steady outline instead)
  const blinkOff = !reducedMotion && state.invulnMs > 0 && Math.floor(state.t / 90) % 2 === 0;
  if (!blinkOff && screen === "game") {
    drawSprite(ctx, SHIP_SPRITE, state.invulnMs > 0 ? SHIP_PALETTE_INVULN : SHIP_PALETTE_NORMAL, PLAYER_X, state.playerY, SPRITE_SCALE);
  } else if (screen === "title") {
    drawSprite(ctx, SHIP_SPRITE, SHIP_PALETTE_NORMAL, PLAYER_X, state.playerY, SPRITE_SCALE);
  }

  // bounds hint
  ctx.strokeStyle = "#8b7cd8";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, PLAYER_MIN_Y - 4);
  ctx.lineTo(WORLD_W, PLAYER_MIN_Y - 4);
  ctx.moveTo(0, PLAYER_MAX_Y + PLAYER_H + 4);
  ctx.lineTo(WORLD_W, PLAYER_MAX_Y + PLAYER_H + 4);
  ctx.stroke();
  ctx.setLineDash([]);

  if (screen === "game") drawHud(ctx, state, highScore);

  ctx.restore();
}
