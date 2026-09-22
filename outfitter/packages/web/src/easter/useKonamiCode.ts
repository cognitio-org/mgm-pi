// Classic Konami code (up up down down left right left right b a) as the discoverable trigger for
// the easter egg -- see docs/reports/easter-egg-research.md's "Triggers" section for why this one
// was picked over the alternatives. Deliberately narrow: it only listens while focus is on
// <body> (not while typing in the composer, a text input, or a textarea), so it can never
// interfere with real use of the app, and it ignores repeated keydown events from a held key.
import { useEffect, useRef } from "react";
import { isTypingTarget } from "./triggers.ts";

const SEQUENCE = [
  "ArrowUp",
  "ArrowUp",
  "ArrowDown",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowLeft",
  "ArrowRight",
  "b",
  "a",
];


/** Calls onTriggered() once the Konami sequence is typed anywhere outside a form field. */
export function useKonamiCode(onTriggered: () => void): void {
  const progressRef = useRef(0);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.repeat || isTypingTarget(e.target)) return;
      const expected = SEQUENCE[progressRef.current];
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === expected) {
        progressRef.current += 1;
        if (progressRef.current === SEQUENCE.length) {
          progressRef.current = 0;
          onTriggered();
        }
      } else {
        progressRef.current = key === SEQUENCE[0] ? 1 : 0;
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onTriggered]);
}
