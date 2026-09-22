// Pure timeline logic for the self-playing Manual tour (~75s, see docs/design/README.md's motion
// language: steps, not eases). Kept free of DOM/React so it's cheap to unit test (see
// test/tour-timeline.test.ts) -- TourAnimation.tsx is the only consumer, driving a rAF/interval
// loop that calls sceneAtTime(t) each frame.
//
// Every scene's caption/meaning is real text, always rendered (not only spoken by the animation),
// per the brief: "the whole story must be understandable with the animation off."

export interface TourScene {
  id: string;
  /** One-line caption shown under the monitor, always visible, aria-live="polite". */
  caption: string;
  /** The plain meaning this beat is teaching. */
  meaning: string;
  /** How long this scene plays for, in ms, during self-playing (auto) mode. */
  durationMs: number;
}

export const TOUR_SCENES: TourScene[] = [
  {
    id: "opening",
    caption: "PRESS PLAY ON TAPE … LOADING",
    meaning: "Outfitter runs coding agents for you -- this is a 75-second tour of how.",
    durationMs: 4000,
  },
  {
    id: "kernal",
    caption: "Kernal wakes up. READY.",
    meaning: "The Kernal is the coding agent that does the work -- on your laptop or in the cloud.",
    durationMs: 8000,
  },
  {
    id: "tapes",
    caption: "A Tape clicks into the deck.",
    meaning: "Tapes are saved agent setups: model, instructions, tools -- pick one to start.",
    durationMs: 8000,
  },
  {
    id: "floppies",
    caption: "A Floppy slides out of the Disk Box.",
    meaning: "A Floppy is one conversation with an agent, saved so you can continue it later.",
    durationMs: 8000,
  },
  {
    id: "drives",
    caption: "The Floppy goes into a Drive in the cloud.",
    meaning: "A Drive is a cloud sandbox running the agent right now, streaming its work back to you.",
    durationMs: 12000,
  },
  {
    id: "diskbox",
    caption: "Back in the Disk Box, ▶ Play spins it up again.",
    meaning: "The Disk Box holds all your Floppies. Stopped ones wake back up with ▶ Play.",
    durationMs: 9000,
  },
  {
    id: "eject",
    caption: "⏏ Eject sends it home.",
    meaning: "Eject takes the Floppy home to continue in Kernal on your laptop, mid-conversation.",
    durationMs: 10000,
  },
  {
    id: "peripherals",
    caption: "Peripherals, Dongles, Control Panel.",
    meaning: "Peripherals are providers, Dongles are your personal tokens, the Control Panel holds keys and settings.",
    durationMs: 9000,
  },
  {
    id: "closing",
    caption: "READY.",
    meaning: "That's the tour. Start a new Floppy whenever you're ready.",
    durationMs: 7000,
  },
];

export function totalDurationMs(scenes: TourScene[] = TOUR_SCENES): number {
  return scenes.reduce((sum, s) => sum + s.durationMs, 0);
}

/** Cumulative start time (ms) of each scene, same length/order as `scenes`. */
export function sceneStarts(scenes: TourScene[] = TOUR_SCENES): number[] {
  const starts: number[] = [];
  let acc = 0;
  for (const s of scenes) {
    starts.push(acc);
    acc += s.durationMs;
  }
  return starts;
}

export interface SceneAtTime {
  index: number;
  scene: TourScene;
  /** ms elapsed within this scene. */
  elapsedMs: number;
  /** 0..1 progress within this scene. */
  progress: number;
  /** true once the timeline has finished playing (t >= total duration). */
  done: boolean;
}

/** Resolves which scene is active at time `t` (ms since playback started), clamped to the
 * timeline's bounds. t < 0 clamps to the first scene at progress 0; t >= totalDuration clamps to
 * the last scene at progress 1 with done=true. */
export function sceneAtTime(t: number, scenes: TourScene[] = TOUR_SCENES): SceneAtTime {
  const total = totalDurationMs(scenes);
  const clamped = Math.max(0, Math.min(t, total));
  const starts = sceneStarts(scenes);
  let index = scenes.length - 1;
  for (let i = 0; i < scenes.length; i++) {
    const start = starts[i];
    const end = start + scenes[i].durationMs;
    if (clamped < end || i === scenes.length - 1) {
      index = i;
      break;
    }
  }
  const scene = scenes[index];
  const elapsedMs = clamped - starts[index];
  const progress = scene.durationMs === 0 ? 1 : Math.min(1, elapsedMs / scene.durationMs);
  return { index, scene, elapsedMs, progress, done: clamped >= total };
}

export function clampSceneIndex(index: number, scenes: TourScene[] = TOUR_SCENES): number {
  return Math.max(0, Math.min(index, scenes.length - 1));
}

export function nextSceneIndex(index: number, scenes: TourScene[] = TOUR_SCENES): number {
  return clampSceneIndex(index + 1, scenes);
}

export function previousSceneIndex(index: number, scenes: TourScene[] = TOUR_SCENES): number {
  return clampSceneIndex(index - 1, scenes);
}

/** The time (ms) at which a given scene index starts -- used to jump playback there (e.g. clicking
 * a progress segment, or resuming after a manual Next/Previous in playing mode). */
export function timeForSceneStart(index: number, scenes: TourScene[] = TOUR_SCENES): number {
  return sceneStarts(scenes)[clampSceneIndex(index, scenes)];
}
