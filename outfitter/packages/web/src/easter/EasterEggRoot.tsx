// Top-level state machine for the easter egg overlay: "menu" (KERNAL GAMES) <-> a running game.
// Each game is its own React.lazy() chunk (src/easter/rescue/FloppyRescue.tsx,
// src/easter/dreadnought/DreadnoughtRun.tsx) so picking "Floppy Rescue" from the menu never fetches
// Dreadnought Run's code and vice versa -- openEasterEgg("rescue"|"dreadnought") also skips the
// menu chunk entirely by starting straight in that game's state.

import { lazy, Suspense, useState } from "react";
import type { GameId } from "./shared/highscore.ts";
import { GameMenu } from "./menu/GameMenu.tsx";

const FloppyRescueLazy = lazy(() => import("./rescue/FloppyRescue.tsx").then((m) => ({ default: m.FloppyRescue })));
const DreadnoughtRunLazy = lazy(() =>
  import("./dreadnought/DreadnoughtRun.tsx").then((m) => ({ default: m.DreadnoughtRun })),
);

interface EasterEggRootProps {
  initialGame?: GameId;
  onClose: () => void;
}

export function EasterEggRoot({ initialGame, onClose }: EasterEggRootProps) {
  const [game, setGame] = useState<GameId | null>(initialGame ?? null);

  function backToMenu() {
    setGame(null);
  }

  if (game === null) {
    return <GameMenu onSelect={setGame} onClose={onClose} />;
  }

  // Escape/close-box inside a game always returns to the menu first (per the brief: "exit back to
  // the menu then the app"); a second Escape/close from the menu itself calls onClose. This holds
  // even when a game was launched directly via openEasterEgg("rescue"|...), so there's always a
  // way back to "pick a different cartridge" without fully closing and reopening.
  return (
    <Suspense fallback={<div className="easter-loading">LOADING...</div>}>
      {game === "rescue" ? <FloppyRescueLazy onClose={backToMenu} /> : <DreadnoughtRunLazy onClose={backToMenu} />}
    </Suspense>
  );
}
