// Typing `SYS 64738` + Enter anywhere outside a form field opens KERNAL GAMES -- the C64 reset
// command, as a second keyboard trigger next to the Konami code. Matching logic is in triggers.ts.
import { useEffect } from "react";
import { createSysCommandMatcher, isTypingTarget } from "./triggers.ts";

export function useSysCommand(onTriggered: () => void): void {
  useEffect(() => {
    const matcher = createSysCommandMatcher();
    function onKeyDown(e: KeyboardEvent) {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isTypingTarget(e.target)) {
        matcher.reset();
        return;
      }
      if (matcher.feed(e.key)) onTriggered();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onTriggered]);
}
