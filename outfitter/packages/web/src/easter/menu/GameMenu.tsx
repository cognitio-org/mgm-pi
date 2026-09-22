// "KERNAL GAMES" -- the GEOS-style launcher dialog shown when the easter egg opens without a game
// pre-selected (Konami code, /ready). Two cartridge-style tiles, each showing its persisted high
// score; keyboard (arrows/Tab to move, Enter/Space to launch, Escape to close) and touch/click
// operable. openEasterEgg("rescue"|"dreadnought") skips this and goes straight to a game.

import { useEffect, useRef, useState } from "react";
import type { GameId } from "../shared/highscore.ts";
import { readHighScore } from "../shared/highscore.ts";
import { handleMenuKey } from "./menuNav.ts";

interface Cartridge {
  id: GameId;
  title: string;
  tagline: string;
  glyph: string; // small pixel-grid glyph drawn with box-drawing-ish characters, no image asset
}

const CARTRIDGES: Cartridge[] = [
  {
    id: "rescue",
    title: "FLOPPY RESCUE",
    tagline: "Fly the Disk Box crew out of a burning server farm.",
    glyph: "✈", // airplane-ish glyph stand-in, rendered via CSS pixel grid below in practice
  },
  {
    id: "dreadnought",
    title: "DREADNOUGHT RUN",
    tagline: "Skim the hull, dodge racks, shoot turrets.",
    glyph: "▶",
  },
];

interface GameMenuProps {
  onSelect: (game: GameId) => void;
  onClose: () => void;
}

export function GameMenu({ onSelect, onClose }: GameMenuProps) {
  const [focusIndex, setFocusIndex] = useState(0);
  const tileRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [scores, setScores] = useState<[number, number]>([0, 0]);

  useEffect(() => {
    setScores([readHighScore("rescue"), readHighScore("dreadnought")]);
  }, []);

  useEffect(() => {
    tileRefs.current[focusIndex]?.focus();
  }, [focusIndex]);

  function onKeyDown(e: React.KeyboardEvent) {
    const result = handleMenuKey(e.key, e.shiftKey, focusIndex, CARTRIDGES.length);
    if (result.action === "close") {
      e.preventDefault();
      onClose();
      return;
    }
    if (result.action === "activate") {
      e.preventDefault();
      onSelect(CARTRIDGES[focusIndex]!.id);
      return;
    }
    if (result.index !== focusIndex) {
      e.preventDefault();
      setFocusIndex(result.index);
    }
  }

  return (
    <div
      className="easter-menu"
      role="dialog"
      aria-modal="true"
      aria-label="Kernal Games"
      onKeyDown={onKeyDown}
    >
      <div className="easter-titlebar">
        <span>** KERNAL GAMES **</span>
        <button type="button" className="easter-close" onClick={onClose} aria-label="Close (Escape)">
          X
        </button>
      </div>
      <div className="easter-menu-body">
        <p className="easter-menu-hint">Pick a cartridge. Arrows/Tab to move, Enter to load, Esc to close.</p>
        <div className="easter-cart-row">
          {CARTRIDGES.map((cart, i) => (
            <button
              key={cart.id}
              type="button"
              ref={(el) => {
                tileRefs.current[i] = el;
              }}
              className={`easter-cart${i === focusIndex ? " focused" : ""}`}
              onFocus={() => setFocusIndex(i)}
              onClick={() => onSelect(cart.id)}
              aria-label={`${cart.title}, high score ${scores[i]}`}
            >
              <span className="easter-cart-glyph" aria-hidden="true">
                {cart.glyph}
              </span>
              <span className="easter-cart-title">{cart.title}</span>
              <span className="easter-cart-tagline">{cart.tagline}</span>
              <span className="easter-cart-score">HI {scores[i]}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
