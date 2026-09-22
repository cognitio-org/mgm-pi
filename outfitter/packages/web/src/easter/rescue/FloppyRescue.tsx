// "FLOPPY RESCUE" -- the main easter-egg game, inspired by (not a copy of) Choplifter: fly a pixel
// helicopter from the Disk Box (home base) out over a scrolling landscape to a burning server farm,
// land, let little Floppy characters board (capacity 8), then fly them home to unload for score.
// No shared names, art, sound or level layout with Choplifter -- see
// docs/reports/easter-egg-research.md for the design rationale.
//
// Self-contained: this component (plus engine.ts/render.ts/sprites.ts/sound.ts) is the entire
// feature surface, always loaded via a dynamic import (see EasterEggRoot.tsx) so it costs nothing in
// the main bundle until triggered.
//
// Rendering: render.ts draws each frame onto a low-res logical canvas (viewW x 132) which CSS scales
// up by an *integer* factor (shared/screen.ts) with `image-rendering: pixelated`, so every logical
// pixel is an exact N x N block on screen. This component owns input, the fixed-step loop, sound
// and the transient effects (particles, blasts, score pops, shake, flash).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  attractInput,
  CAPACITY,
  createInitialState,
  GROUND_Y,
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
import { drawRescue, RUNNER_MS, type Runner } from "./render.ts";
import {
  markTutorialSeen,
  nextTutorialStep,
  tutorialIndex,
  tutorialPrompt,
  tutorialSeen,
  type TutorialStep,
} from "./tutorial.ts";
import { readHighScore, writeHighScoreIfBetter } from "../shared/highscore.ts";
import { usesReducedMotion } from "../shared/motion.ts";
import { useFixedStepLoop } from "../shared/fixedStep.ts";
import { readGamepadButtons, readGamepadDirection } from "../shared/gamepad.ts";
import { usePixelScale } from "../shared/screen.ts";
import { useModalFocus } from "../shared/modalFocus.ts";
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

interface FloppyRescueProps {
  onClose: () => void;
}

export function FloppyRescue({ onClose }: FloppyRescueProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<GameState>(createInitialState(gameSeed()));
  const inputRef = useRef<GameInput>({ up: false, down: false, left: false, right: false });
  const particlesRef = useRef<Particle[]>([]);
  const blastsRef = useRef<Blast[]>([]);
  const popupsRef = useRef<TextPopup[]>([]);
  const flashRef = useRef<FlashState | null>(null);
  const shakeRef = useRef<ShakeState | null>(null);
  const facingRef = useRef<1 | -1>(1);
  // After a crash the engine respawns the chopper at home and cuts its camera back there; hold the
  // *rendered* camera on the wreck for a moment first so the explosion is actually seen.
  const crashHoldRef = useRef<{ cameraX: number; remainingMs: number } | null>(null);
  const lastPauseButtonRef = useRef(false);
  const wasAirborneRef = useRef(false);
  const heldRef = useRef<{ up: boolean; down: boolean }>({ up: false, down: false });
  const runnersRef = useRef<Runner[]>([]);
  // first-game tutorial: current prompt + how long the final prompt has been up (null = no tutorial)
  const tutorialRef = useRef<{ step: TutorialStep; finishMs: number } | null>(null);
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
  const { scale, viewW } = usePixelScale(WORLD_W, WORLD_H);
  const touchWording = useMemo(() => {
    if (forceTouch) return true;
    try {
      return window.matchMedia("(pointer: coarse)").matches;
    } catch {
      return false;
    }
  }, [forceTouch]);

  const exit = useCallback(() => {
    stopRotor();
    writeHighScoreIfBetter("rescue", stateRef.current.score);
    onClose();
  }, [onClose]);

  function resetEffects() {
    particlesRef.current = [];
    blastsRef.current = [];
    popupsRef.current = [];
    flashRef.current = null;
    shakeRef.current = null;
    runnersRef.current = [];
  }

  /** `tutorial` defaults to "first game on this browser" (never in the ?demo=1 autopilot). */
  function startGame(tutorial: boolean = !autoDemo && !tutorialSeen()) {
    stateRef.current = createInitialState(gameSeed(), { tutorial });
    tutorialRef.current = tutorial ? { step: "lift", finishMs: 0 } : null;
    resetEffects();
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

  /** Turns engine events into juice: a debris-throwing blast + white hit-flash + shake on a crash,
   * a small blast when a Floppy is lost to the fire, sparkles on boarding, sparkles and a "+N" pop
   * on delivery. Under reduced motion: no shake, no screen flash, no flying debris -- the blast
   * frames and pops stay (they're brief and don't move the scene). */
  function applyEvents(events: GameEvent[], silent = false) {
    for (const ev of events) {
      const x = (ev.x ?? stateRef.current.playerX) + 13;
      const y = (ev.y ?? stateRef.current.playerY) + 7;
      if (ev.type === "boarded") {
        if (!silent) playBoard();
        if (ev.fromX !== undefined) {
          runnersRef.current = runnersRef.current.concat({
            fromX: ev.fromX,
            toX: x,
            ageMs: 0,
            color: stateRef.current.onBoard - 1,
          });
        }
        particlesRef.current = particlesRef.current.concat(spawnSparkle(x, y + 4, reducedMotion ? 2 : 7, C.lightGreen));
      } else if (ev.type === "delivered") {
        const amount = (ev.count ?? 0) * 100 + (ev.count === CAPACITY ? 400 : 0);
        if (silent) {
          // no sound on the title screen
        } else if (ev.count === CAPACITY) playFullLoadBonus();
        else playDeliver();
        // pop above the Disk Box roofline, clear of its white DISK BOX plate
        popupsRef.current = popupsRef.current.concat(spawnTextPopup(x, y - 30, `+${amount}`, C.yellow));
        particlesRef.current = particlesRef.current.concat(spawnSparkle(x, y, reducedMotion ? 3 : 12, C.yellow));
      } else if (ev.type === "hardLanding") {
        // bumpy but survivable: a thud, a jolt, dust off the skids and a warning pop
        if (!silent) playThud();
        popupsRef.current = popupsRef.current.concat(spawnTextPopup(x, y - 18, "HARD LANDING", C.orange));
        particlesRef.current = particlesRef.current.concat(spawnSparkle(x, GROUND_Y - 1, reducedMotion ? 2 : 8, C.lightGrey));
        if (!reducedMotion) shakeRef.current = triggerShake(3);
      } else if (ev.type === "crash") {
        if (!silent) playCrash();
        blastsRef.current = blastsRef.current.concat(spawnBlast(x, y, reducedMotion ? 1 : 2));
        if (!reducedMotion) {
          flashRef.current = triggerFlash(C.white, 120);
          particlesRef.current = particlesRef.current.concat(spawnExplosionParticles(x, y, 18, C.paper));
          shakeRef.current = triggerShake(4);
        }
      } else if (ev.type === "floppyLost") {
        if (!silent) playFloppyLost();
        const fx = ev.x ?? 0;
        const fy = GROUND_Y - 7;
        blastsRef.current = blastsRef.current.concat(spawnBlast(fx, fy, 1));
        if (!reducedMotion) particlesRef.current = particlesRef.current.concat(spawnExplosionParticles(fx, fy, 6, C.lightGreen));
      }
    }
  }

  function stepEffects(dtMs: number, before: GameState, after: GameState) {
    const hold = crashHoldRef.current;
    if (hold) crashHoldRef.current = hold.remainingMs > dtMs ? { ...hold, remainingMs: hold.remainingMs - dtMs } : null;
    if (after.events.some((e) => e.type === "crash") && after.status !== "gameover") {
      crashHoldRef.current = { cameraX: before.cameraX, remainingMs: 800 };
    }
    particlesRef.current = stepParticles(particlesRef.current, dtMs, 160);
    blastsRef.current = stepBlasts(blastsRef.current, dtMs);
    popupsRef.current = stepTextPopups(popupsRef.current, dtMs);
    shakeRef.current = stepShake(shakeRef.current, dtMs);
    flashRef.current = stepFlash(flashRef.current, dtMs);
    runnersRef.current = runnersRef.current
      .map((r) => ({ ...r, ageMs: r.ageMs + dtMs }))
      .filter((r) => r.ageMs < RUNNER_MS);
    const vx = stateRef.current.playerVx;
    if (vx > 4) facingRef.current = 1;
    else if (vx < -4) facingRef.current = -1;
  }

  const loopActive = calmAcknowledged;
  const onStep = useCallback(
    (dtMs: number) => {
      if (screen === "title") {
        const before = stateRef.current;
        const botInput = attractInput(before);
        heldRef.current = { up: botInput.up, down: botInput.down };
        let after = step(before, botInput, dtMs);
        if (after.status === "gameover") after = createInitialState((Date.now() + before.t) & 0xffffffff);
        stateRef.current = after;
        stepEffects(dtMs, before, after);
        // the attract demo gets the same visual juice as real play, but stays silent
        applyEvents(after.events, true);
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

      heldRef.current = { up: merged.up, down: merged.down };
      const before = stateRef.current;
      const after = step(before, merged, dtMs);
      stateRef.current = after;
      stepEffects(dtMs, before, after);

      const tut = tutorialRef.current;
      if (tut && after.status !== "paused") {
        const finishMs = tut.step === "finish" ? tut.finishMs + dtMs : 0;
        const next = nextTutorialStep(tut.step, after, after.events, finishMs);
        if (next === "done") {
          markTutorialSeen();
          tutorialRef.current = null;
        } else {
          tutorialRef.current = { step: next, finishMs: next === "finish" ? finishMs : 0 };
        }
      }

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
    drawRescue(canvasRef.current, {
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
      facing: facingRef.current,
      cameraXOverride: crashHoldRef.current?.cameraX,
      held: heldRef.current,
      runners: runnersRef.current,
    });
    forceRender((n) => (n + 1) % 1000000);
  }, [reducedMotion, screen, highScore, viewW]);
  useFixedStepLoop(onStep, onRender, loopActive);
  // Trap Tab inside the dialog and hand focus back to whatever opened it (Trash icon, "SYS
  // 64738" menu item, ...) on close -- this overlay is mounted outside the React app tree (see
  // openEasterEgg.tsx), so nothing else does this, and the window-level arrow/WASD listeners
  // above would otherwise happily fire while focus sits in a background text field.
  useModalFocus(overlayRef, true);

  function restart() {
    stopRotor();
    startGame(false);
  }

  const s = stateRef.current;
  const status = s.status;
  const fuelPct = Math.max(0, Math.min(100, Math.round(s.fuel)));

  return (
    <div ref={overlayRef} className="easter-overlay" role="dialog" aria-modal="true" aria-label="Floppy Rescue easter egg">
      <div className="easter-frame easter-frame-game">
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
                  <p className="easter-title-name easter-sr-only">FLOPPY RESCUE</p>
                  <p className="easter-title-sub easter-sr-only">HI {highScore}</p>
                  <p className="easter-story">The server farm is on fire. Fly your Floppies home.</p>
                  <div className="easter-title-actions">
                    <button type="button" className="btn btn-primary" onClick={() => startGame()}>
                      Press start
                    </button>
                    <button type="button" className="btn" onClick={() => startGame(true)}>
                      How to play
                    </button>
                  </div>
                </div>
              )}
              {screen === "game" && tutorialRef.current && tutorialPrompt(tutorialRef.current.step, touchWording) && (
                <div className="easter-tutorial" role="status" aria-live="polite">
                  <span className="easter-tutorial-step">{tutorialIndex(tutorialRef.current.step)}/6</span>
                  {tutorialPrompt(tutorialRef.current.step, touchWording)}
                </div>
              )}
              {screen === "game" && status === "levelIntro" && (
                <div className="easter-level-card">
                  <p>{s.levelText}</p>
                </div>
              )}
            </div>
            {screen === "title" && (
              // controls summary under the canvas (not over it), so the attract demo stays visible
              <p className="easter-help easter-help-controls">
                {touchWording
                  ? "Hold LIFT to climb, drag the stick to fly. Land gently beside the farm, then on the home pad."
                  : "↑ lift, ← → fly, let go of ↑ to land gently beside the farm, then on the home pad. P pauses, Esc exits."}
              </p>
            )}
            {screen === "game" && (
              // The score/fuel/lives HUD is drawn inside the canvas; this text copy is kept for
              // screen readers only.
              <div className="easter-hud easter-hud-rescue easter-sr-only">
                <span>SCORE {Math.floor(s.score)}</span>
                <span>HI {Math.floor(highScore)}</span>
                <span>LV {s.level}</span>
                <span>
                  ON BOARD {s.onBoard}/{CAPACITY}
                </span>
                <span>FUEL {fuelPct}%</span>
                <span>LIVES {s.lives}</span>
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
            {screen === "game" && (
              <p className="easter-help">
                Arrows/WASD fly. Land in the green zone beside the farm, then on the home pad. Watch the
                gauge: green is safe. P pauses, Escape exits.
              </p>
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
