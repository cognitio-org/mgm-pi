// The Manual's centrepiece: a ~75s self-playing walkthrough of Outfitter's vocabulary, framed as a
// C64-style "monitor" panel. Pure SVG/CSS/React -- no video files, no new heavy dependencies (see
// scenes.tsx for the original pixel-art scenes, tour-timeline.ts for the pure playback math this
// component drives). Captions are always real text (aria-live="polite") so the story is
// understandable with the animation off, and prefers-reduced-motion swaps the whole thing for a
// static step-by-step storyboard with Next/Previous -- same content, no autoplay, no CSS motion.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TOUR_SCENES,
  nextSceneIndex,
  previousSceneIndex,
  sceneAtTime,
  timeForSceneStart,
  totalDurationMs,
} from "./tour-timeline.ts";
import { SCENE_COMPONENTS } from "./scenes.tsx";
import { isSoundEnabled, playFloppyAfterDelay } from "../../lib/floppy-sound.ts";

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      const onChange = () => setReduced(mq.matches);
      mq.addEventListener?.("change", onChange);
      return () => mq.removeEventListener?.("change", onChange);
    } catch {
      return undefined;
    }
  }, []);
  return reduced;
}

export interface TourAnimationProps {
  /** Start playing immediately on mount (used by /manual?autoplay=1 for the recorder script). */
  autoplay?: boolean;
}

export function TourAnimation({ autoplay = false }: TourAnimationProps) {
  const reducedMotion = usePrefersReducedMotion();
  const total = useMemo(() => totalDurationMs(), []);

  // --- playing (motion) mode state ---
  const [playing, setPlaying] = useState(autoplay && !reducedMotion);
  const [elapsed, setElapsed] = useState(0);
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number | null>(null);
  const soundStoppedForSceneRef = useRef<string | null>(null);

  // --- storyboard (reduced-motion / step) mode state ---
  const [stepIndex, setStepIndex] = useState(0);

  const at = sceneAtTime(elapsed);

  const tick = useCallback((now: number) => {
    if (lastTickRef.current === null) lastTickRef.current = now;
    const dt = now - lastTickRef.current;
    lastTickRef.current = now;
    setElapsed((prev) => {
      const next = Math.min(prev + dt, total);
      return next;
    });
    rafRef.current = requestAnimationFrame(tick);
  }, [total]);

  useEffect(() => {
    if (reducedMotion) return undefined;
    if (!playing) {
      lastTickRef.current = null;
      return undefined;
    }
    if (elapsed >= total) {
      setPlaying(false);
      return undefined;
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, reducedMotion, elapsed >= total]);

  // Short floppy-sound burst when the "drives" scene comes on screen, only if the user has already
  // turned sound on in the header -- never autoplay audio otherwise (floppy-sound.ts's own rule).
  useEffect(() => {
    if (reducedMotion || !playing) return undefined;
    if (at.scene.id !== "drives") return undefined;
    if (soundStoppedForSceneRef.current === "drives") return undefined;
    if (!isSoundEnabled()) return undefined;
    soundStoppedForSceneRef.current = "drives";
    const stop = playFloppyAfterDelay();
    const timer = window.setTimeout(stop, 1400);
    return () => {
      window.clearTimeout(timer);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at.scene.id, playing, reducedMotion]);

  useEffect(() => {
    if (at.scene.id !== "drives") soundStoppedForSceneRef.current = null;
  }, [at.scene.id]);

  const goToScene = useCallback(
    (index: number) => {
      setElapsed(timeForSceneStart(index));
    },
    [],
  );

  function handlePlayPause() {
    if (elapsed >= total) setElapsed(0);
    setPlaying((p) => !p);
  }

  function handlePrev() {
    if (reducedMotion) {
      setStepIndex((i) => previousSceneIndex(i));
    } else {
      goToScene(previousSceneIndex(at.index));
    }
  }

  function handleNext() {
    if (reducedMotion) {
      setStepIndex((i) => nextSceneIndex(i));
    } else {
      goToScene(nextSceneIndex(at.index));
    }
  }

  function handleSkip() {
    if (reducedMotion) {
      setStepIndex(TOUR_SCENES.length - 1);
    } else {
      setPlaying(false);
      setElapsed(total);
    }
  }

  function handleReplay() {
    if (reducedMotion) {
      setStepIndex(0);
    } else {
      setElapsed(0);
      setPlaying(true);
    }
  }

  const activeScene = reducedMotion ? TOUR_SCENES[stepIndex] : at.scene;
  const activeIndex = reducedMotion ? stepIndex : at.index;
  const SceneComponent = SCENE_COMPONENTS[activeScene.id] ?? SCENE_COMPONENTS.opening;
  const finished = reducedMotion ? stepIndex === TOUR_SCENES.length - 1 : at.done;

  return (
    <div className="tour" data-testid="tour-animation">
      <div className="tour-monitor panel">
        <div className="panel-titlebar">
          <span className="panel-label">MANUAL.PRG</span>
        </div>
        <div className="tour-screen">
          <div className="tour-scanlines" aria-hidden="true" />
          <SceneComponent key={activeScene.id} />
        </div>
      </div>

      <p className="tour-caption" aria-live="polite">
        <strong>{activeScene.caption}</strong> {activeScene.meaning}
      </p>

      {reducedMotion ? (
        <div className="tour-storyboard-note">
          Reduced-motion storyboard: step through with Previous / Next.
        </div>
      ) : null}

      <div className="tour-controls">
        <button
          type="button"
          className="btn"
          onClick={handlePrev}
          disabled={activeIndex === 0}
          aria-label="Previous scene"
        >
          ◀ Prev
        </button>
        {!reducedMotion && (
          <button type="button" className="btn btn-primary" onClick={handlePlayPause} aria-label={playing ? "Pause tour" : "Play tour"}>
            {playing ? "⏸ Pause" : finished ? "↻ Replay" : "▶ Play"}
          </button>
        )}
        <button
          type="button"
          className="btn"
          onClick={handleNext}
          disabled={activeIndex === TOUR_SCENES.length - 1}
          aria-label="Next scene"
        >
          Next ▶
        </button>
        <button type="button" className="btn" onClick={handleSkip} disabled={finished}>
          Skip
        </button>
      </div>

      <div className="tour-progress" role="tablist" aria-label="Tour scenes">
        {TOUR_SCENES.map((scene, i) => (
          <button
            key={scene.id}
            type="button"
            role="tab"
            aria-selected={i === activeIndex}
            aria-label={`Scene ${i + 1}: ${scene.caption}`}
            className={
              "tour-progress-seg" +
              (i < activeIndex ? " tour-progress-seg-done" : "") +
              (i === activeIndex ? " tour-progress-seg-active" : "")
            }
            onClick={() => (reducedMotion ? setStepIndex(i) : goToScene(i))}
          />
        ))}
      </div>

      {finished && (
        <div className="tour-end-actions">
          <a href="/" className="btn btn-primary">
            Start a new floppy
          </a>
          <button type="button" className="btn" onClick={handleReplay}>
            Replay
          </button>
        </div>
      )}
    </div>
  );
}
