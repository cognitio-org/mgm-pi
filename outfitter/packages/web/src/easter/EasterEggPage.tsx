// Hidden route (/ready -- a nod to the C64's "READY." prompt) that mounts the easter egg full
// screen. This exists mainly as a stable, easy-to-reach target for manual testing and screenshots
// while the desk/composer/header are being reworked elsewhere; the real discoverable trigger is
// the Konami-code listener wired in App.tsx (see useKonamiCode.ts). Both paths funnel through the
// same openEasterEgg()/EasterEgg component, and both are code-split the same way.

import { lazy, Suspense } from "react";
import { useNavigate } from "react-router-dom";

const EasterEggLazy = lazy(() => import("./EasterEgg.tsx").then((m) => ({ default: m.EasterEgg })));

export function EasterEggPage() {
  const navigate = useNavigate();
  return (
    <Suspense fallback={null}>
      <EasterEggLazy onClose={() => navigate("/")} />
    </Suspense>
  );
}
