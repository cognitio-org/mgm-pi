// "DREADNOUGHT RUN" -- a small Uridium-inspired horizontal scrolling shooter easter egg. Skim a
// ship low over a giant data-center dreadnought, dodge server racks, shoot turrets, grab stray
// Floppies. Not a copy of Uridium: no shared names, art, sound, or level layout -- see
// docs/reports/easter-egg-research.md for the design rationale.
//
// Self-contained: this component (plus engine.ts/sound.ts) is the entire feature surface. It is
// always loaded via a dynamic import (see openEasterEgg.ts / EasterEggPage.tsx) so it costs
// nothing in the main bundle until triggered.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createInitialState,
  PLAYER_H,
  PLAYER_MIN_Y,
  PLAYER_MAX_Y,
  PLAYER_W,
  PLAYER_X,
  readHighScore,
  step,
  togglePause,
  WORLD_H,
  WORLD_W,
  writeHighScoreIfBetter,
  type GameInput,
  type GameState,
} from "./engine.ts";
import { playExplosion, playGameOver, playHit, playLaser, playPickup } from "./sound.ts";

interface EasterEggProps {
  onClose: () => void;
}

function usesReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function EasterEgg({ onClose }: EasterEggProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<GameState>(createInitialState(Date.now() & 0xffffffff));
  const inputRef = useRef<GameInput>({ up: false, down: false, firing: false });
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const [, forceRender] = useState(0);
  const [highScore, setHighScore] = useState(() => readHighScore());
  const reducedMotion = useMemo(() => usesReducedMotion(), []);
  const [calmAcknowledged, setCalmAcknowledged] = useState(!reducedMotion);

  const exit = useCallback(() => {
    const s = stateRef.current;
    writeHighScoreIfBetter(s.score);
    onClose();
  }, [onClose]);

  // --- keyboard controls ---
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        exit();
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
  }, [exit]);

  // --- game loop ---
  useEffect(() => {
    if (!calmAcknowledged) return;
    function frame(ts: number) {
      const last = lastTsRef.current;
      lastTsRef.current = ts;
      const dtMs = last === null ? 16 : ts - last;
      const before = stateRef.current;
      const after = step(before, inputRef.current, dtMs);
      stateRef.current = after;

      if (after.status === "playing") {
        if (after.bullets.length > before.bullets.length) playLaser();
        if (after.score > before.score) {
          if (after.obstacles.length < before.obstacles.length && after.score - before.score >= 150) playExplosion();
          else playPickup();
        }
        if (after.invulnMs > 0 && before.invulnMs === 0) playHit();
      } else if (after.status === "gameover" && before.status === "playing") {
        playGameOver();
        setHighScore(writeHighScoreIfBetter(after.score));
      }

      draw(canvasRef.current, after, reducedMotion);
      rafRef.current = requestAnimationFrame(frame);
    }
    rafRef.current = requestAnimationFrame(frame);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      lastTsRef.current = null;
    };
  }, [calmAcknowledged, reducedMotion]);

  function restart() {
    stateRef.current = createInitialState(Date.now() & 0xffffffff);
    forceRender((n) => n + 1);
  }

  const status = stateRef.current.status;

  return (
    <div className="easter-overlay" role="dialog" aria-modal="true" aria-label="Dreadnought Run easter egg">
      <div className="easter-frame">
        <div className="easter-titlebar">
          <span>** DREADNOUGHT RUN **</span>
          <button type="button" className="easter-close" onClick={exit} aria-label="Close (Escape)">
            X
          </button>
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
            <canvas
              ref={canvasRef}
              width={WORLD_W}
              height={WORLD_H}
              className="easter-canvas"
              aria-label="Game screen"
            />
            <div className="easter-hud">
              <span>SCORE {Math.floor(stateRef.current.score)}</span>
              <span>HI {Math.floor(highScore)}</span>
              <span>LIVES {"* ".repeat(Math.max(0, stateRef.current.lives)).trim() || "-"}</span>
            </div>
            {status === "paused" && (
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
            {status === "gameover" && (
              <div className="easter-modal">
                <p>GAME OVER</p>
                <p>SCORE {Math.floor(stateRef.current.score)}</p>
                <button type="button" className="btn btn-primary" onClick={restart}>
                  Play again
                </button>
              </div>
            )}
            <div className="easter-touch-controls" aria-hidden={false}>
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
            <p className="easter-help">Arrows/WASD move, Space fires, P pauses, Escape exits.</p>
          </>
        )}
      </div>
    </div>
  );
}

function draw(canvas: HTMLCanvasElement | null, state: GameState, reducedMotion: boolean): void {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.fillStyle = "#241e5c";
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  // dreadnought hull texture: a sparse grid, static (not scrolled) under reduced motion to keep
  // the backdrop calm while gameplay itself stays legible.
  ctx.strokeStyle = "#3a3184";
  ctx.lineWidth = 1;
  const gridOffset = reducedMotion ? 0 : state.distance % 40;
  for (let x = -gridOffset; x < WORLD_W; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, WORLD_H);
    ctx.stroke();
  }

  // obstacles
  for (const o of state.obstacles) {
    ctx.fillStyle = o.kind === "rack" ? "#8b7cd8" : o.hp > 1 ? "#f4cf3c" : "#ff8a8a";
    ctx.fillRect(o.x, o.y, o.w, o.h);
  }

  // pickups (floppies)
  for (const p of state.pickups) {
    ctx.fillStyle = "#5cff8a";
    ctx.fillRect(p.x - 5, p.y - 5, 10, 10);
    ctx.fillStyle = "#241e5c";
    ctx.fillRect(p.x - 3, p.y - 5, 6, 3);
  }

  // bullets
  ctx.fillStyle = "#e4e0fb";
  for (const b of state.bullets) ctx.fillRect(b.x - 3, b.y - 1.5, 6, 3);
  ctx.fillStyle = "#ff8a8a";
  for (const b of state.enemyBullets) ctx.fillRect(b.x - 3, b.y - 1.5, 6, 3);

  // player ship (blinks while invulnerable, unless reduced motion -- then a steady outline instead)
  const blinkOff = !reducedMotion && state.invulnMs > 0 && Math.floor(state.t / 90) % 2 === 0;
  if (!blinkOff) {
    ctx.fillStyle = state.invulnMs > 0 ? "#f4cf3c" : "#5cff8a";
    ctx.beginPath();
    ctx.moveTo(PLAYER_X, state.playerY + PLAYER_H / 2);
    ctx.lineTo(PLAYER_X + PLAYER_W, state.playerY);
    ctx.lineTo(PLAYER_X + PLAYER_W, state.playerY + PLAYER_H);
    ctx.closePath();
    ctx.fill();
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
}
