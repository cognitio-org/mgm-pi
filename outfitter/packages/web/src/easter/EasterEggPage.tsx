// Hidden route (/ready -- a nod to the C64's "READY." prompt) that mounts the easter egg full
// screen, starting at the KERNAL GAMES menu. This exists mainly as a stable, easy-to-reach target
// for manual testing and screenshots while the desk/composer/header are being reworked elsewhere;
// the real discoverable trigger is the Konami-code listener wired in App.tsx (see
// useKonamiCode.ts). Both paths funnel through the same openEasterEgg()/EasterEggRoot component,
// and both are code-split the same way. `?game=rescue` or `?game=dreadnought` (and `?demo=1`, read
// by each game's own attract-mode logic) let screenshots/tests jump straight past the menu.

import { lazy, Suspense } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { GameId } from "./shared/highscore.ts";

const EasterEggRootLazy = lazy(() => import("./EasterEggRoot.tsx").then((m) => ({ default: m.EasterEggRoot })));

function parseGame(raw: string | null): GameId | undefined {
  return raw === "rescue" || raw === "dreadnought" ? raw : undefined;
}

export function EasterEggPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialGame = parseGame(params.get("game"));
  return (
    <Suspense fallback={null}>
      <EasterEggRootLazy initialGame={initialGame} onClose={() => navigate("/")} />
    </Suspense>
  );
}
