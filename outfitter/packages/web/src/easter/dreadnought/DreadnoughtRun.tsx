// "DREADNOUGHT RUN" -- a small Uridium-inspired horizontal scrolling shooter easter egg. Skim a
// ship low over a giant data-center dreadnought, dodge server racks, shoot turrets and drones,
// grab stray Floppies. Not a copy of Uridium: no shared names, art, sound, or level layout -- see
// docs/reports/easter-egg-research.md for the design rationale.
//
// Self-contained: this component (plus engine.ts/render.ts/sprites.ts/sound.ts) is the entire
// feature surface. It is always loaded via a dynamic import (see EasterEggRoot.tsx) so it costs
// nothing in the main bundle until triggered. render.ts draws each frame onto a low-res canvas that
// CSS scales by an integer factor (shared/screen.ts); this component owns input, the loop, sound
// and the transient effects.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  attractInput,
  createInitialState,
  step,
  togglePause,
  WORLD_H,
  WORLD_W,
  type GameEvent,
  type GameInput,
  type GameState,
} from "./engine.ts";
import { playExplosion, playGameOver, playHit, playLaser, playPickup } from "./sound.ts";
import { drawDreadnought } from "./render.ts";
import { readHighScore, writeHighScoreIfBetter } from "../shared/highscore.ts";
import { usesReducedMotion } from "../shared/motion.ts";
import { useFixedStepLoop } from "../shared/fixedStep.ts";
import { readGamepadButtons, readGamepadDirection } from "../shared/gamepad.ts";
import { usePixelScale } from "../shared/screen.ts";
import { gameSeed, readQueryFlag } from "../shared/query.ts";
import { C } from "../shared/palette.ts";
import { spawnBlast, stepBlasts, type Blast } from "../shared/fx.ts";
import {
  spawnExplosionParticles,
  spawnSparkle,
  spawnTextPopup,
  stepFlash,
  stepParticles,
  stepShake,
  stepTextPopups,
  triggerFlash,
  triggerShake,
  type FlashState,
  type Particle,
  type ShakeState,
  type TextPopup,
} from "../shared/particles.ts";

interface DreadnoughtRunProps {
  onClose: () => void;
}

export function DreadnoughtRun({ onClose }: DreadnoughtRunProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<GameState>(createInitialState(gameSeed()));
  const inputRef = useRef<GameInput>({ up: false, down: false, firing: false });
  const particlesRef = useRef<Particle[]>([]);
  const blastsRef = useRef<Blast[]>([]);
  const popupsRef = useRef<TextPopup[]>([]);
  const flashRef = useRef<FlashState | null>(null);
  const shakeRef = useRef<ShakeState | null>(null);
  const lastPauseButtonRef = useRef(false);
  const [, forceRender] = useState(0);
  const [highScore, setHighScore] = useState(() => readHighScore("dreadnought"));
  const reducedMotion = useMemo(() => usesReducedMotion(), []);
  const [calmAcknowledged, setCalmAcknowledged] = useState(!reducedMotion);
  const [screen, setScreen] = useState<"title" | "game">("title");
  const autoDemo = useMemo(() => readQueryFlag("demo"), []);
  const forceTouch = useMemo(() => readQueryFlag("touch"), []);
  const { scale, viewW } = usePixelScale(WORLD_W, WORLD_H);

  const exit = useCallback(() => {
    const s = stateRef.current;
    writeHighScoreIfBetter("dreadnought", s.score);
    onClose();
  }, [onClose]);

  function startGame() {
    stateRef.current = createInitialState(gameSeed());
    particlesRef.current = [];
    blastsRef.current = [];
    popupsRef.current = [];
    flashRef.current = null;
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

  /** Juice: a blast + tumbling debris + "+N" pop per kill, sparkles + pop per pickup, a big blast +
   * white hit-flash + shake when the ship is hit. Reduced motion keeps the blast frames and pops,
   * drops shake, screen flash and flying debris. */
  function applyEvents(events: GameEvent[]) {
    for (const ev of events) {
      if (ev.type === "obstacleDestroyed") {
        const cx = ev.x + 9;
        const cy = ev.y + 9;
        blastsRef.current = blastsRef.current.concat(spawnBlast(cx, cy, 1));
        if (!reducedMotion) {
          particlesRef.current = particlesRef.current.concat(spawnExplosionParticles(cx, cy, 12, C.yellow));
          shakeRef.current = triggerShake(2);
        }
        if (ev.score) popupsRef.current = popupsRef.current.concat(spawnTextPopup(cx, cy - 12, `+${ev.score}`, C.yellow));
      } else if (ev.type === "pickupCollected") {
        particlesRef.current = particlesRef.current.concat(spawnSparkle(ev.x, ev.y, reducedMotion ? 3 : 10, C.lightGreen));
        if (ev.score) popupsRef.current = popupsRef.current.concat(spawnTextPopup(ev.x, ev.y - 10, `+${ev.score}`, C.lightGreen));
      } else if (ev.type === "playerHit") {
        const cx = ev.x + 13;
        const cy = ev.y + 7;
        blastsRef.current = blastsRef.current.concat(spawnBlast(cx, cy, reducedMotion ? 1 : 2));
        if (!reducedMotion) {
          flashRef.current = triggerFlash(C.white, 120);
          particlesRef.current = particlesRef.current.concat(spawnExplosionParticles(cx, cy, 16, C.paper));
          shakeRef.current = triggerShake(4);
        }
      }
    }
  }

  function stepEffects(dtMs: number) {
    particlesRef.current = stepParticles(particlesRef.current, dtMs, 120);
    blastsRef.current = stepBlasts(blastsRef.current, dtMs);
    popupsRef.current = stepTextPopups(popupsRef.current, dtMs);
    shakeRef.current = stepShake(shakeRef.current, dtMs);
    flashRef.current = stepFlash(flashRef.current, dtMs);
  }

  // --- fixed-timestep game loop (title attract-mode or real play) ---
  const loopActive = calmAcknowledged;
  const onStep = useCallback(
    (dtMs: number) => {
      if (screen === "title") {
        const before = stateRef.current;
        const botInput = attractInput(before.t, before);
        let after = step(before, botInput, dtMs);
        if (after.status === "gameover") after = createInitialState((Date.now() + before.t) & 0xffffffff);
        stateRef.current = after;
        stepEffects(dtMs);
        applyEvents(after.events); // the attract demo gets the same visual juice, silently
        return;
      }
      const gp = readGamepadDirection();
      const gpButtons = readGamepadButtons();
      // ?demo=1 keeps the attract-mode autopilot flying even past the title screen, so a headless
      // screenshot/video of "mid-game" shows real action instead of an idle, unpiloted ship.
      const merged: GameInput = autoDemo
        ? attractInput(stateRef.current.t, stateRef.current)
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
      stepEffects(dtMs);

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
    drawDreadnought(canvasRef.current, {
      state: stateRef.current,
      viewW,
      particles: particlesRef.current,
      blasts: blastsRef.current,
      popups: popupsRef.current,
      shake: shakeRef.current,
      flash: flashRef.current,
      reducedMotion,
      screen,
      highScore,
    });
    forceRender((n) => (n + 1) % 1000000);
  }, [reducedMotion, screen, highScore, viewW]);
  useFixedStepLoop(onStep, onRender, loopActive);

  function restart() {
    startGame();
  }

  const status = stateRef.current.status;

  return (
    <div className="easter-overlay" role="dialog" aria-modal="true" aria-label="Dreadnought Run easter egg">
      <div className="easter-frame easter-frame-game">
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
                width={viewW}
                height={WORLD_H}
                className="easter-canvas"
                style={{ width: viewW * scale, height: WORLD_H * scale }}
                aria-label="Game screen"
              />
              {screen === "title" && (
                <div className="easter-title-overlay">
                  <p className="easter-title-name easter-sr-only">DREADNOUGHT RUN</p>
                  <p className="easter-title-sub easter-sr-only">HI {highScore}</p>
                  <button type="button" className="btn btn-primary" onClick={startGame}>
                    Press start
                  </button>
                  <p className="easter-help">Arrows/WASD move, Space fires, P pauses, Escape exits. Gamepad supported.</p>
                </div>
              )}
            </div>
            {screen === "game" && (
              // drawn in-canvas; this copy is for screen readers
              <div className="easter-hud easter-sr-only">
                <span>SCORE {Math.floor(stateRef.current.score)}</span>
                <span>HI {Math.floor(highScore)}</span>
                <span>LIVES {stateRef.current.lives}</span>
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
