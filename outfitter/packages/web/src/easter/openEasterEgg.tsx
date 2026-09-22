// Trigger surface for the easter egg. Deliberately tiny and decoupled from any one UI: whichever
// part of the app wants to launch the game (a Konami-code listener, a hidden menu item, a
// composer command -- see docs/reports/easter-egg-research.md's "Triggers" section) just calls
// openEasterEgg(). Everything else (React, the game engine, the canvas renderer) is behind a
// dynamic import, so this file -- and therefore the trigger site -- costs only a few bytes until
// the moment someone actually finds it.

import { createRoot, type Root } from "react-dom/client";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function close(): void {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
}

/** Mounts the easter egg into a fresh DOM node appended to <body>, outside the React app tree, so
 * it can be triggered from anywhere (including non-React code, a global key listener, or a route)
 * without prop-drilling. Safe to call multiple times -- a second call while already open is a
 * no-op. */
export async function openEasterEgg(): Promise<void> {
  if (root) return; // already open
  const { EasterEgg } = await import("./EasterEgg.tsx");
  container = document.createElement("div");
  container.id = "outfitter-easter-egg-root";
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(<EasterEgg onClose={close} />);
}
