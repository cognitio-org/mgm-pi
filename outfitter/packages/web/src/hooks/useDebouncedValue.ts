import { useEffect, useState } from "react";

/** Returns `value` once it has been stable for `delayMs`; before the very first settle (including
 * during the initial `delayMs` after mount) it returns `undefined` instead of the initial value,
 * deliberately: MermaidDiagram uses this to avoid parsing/rendering a diagram fence while an
 * assistant message is still streaming in, and the very first render can itself be mid-stream
 * (the first chunk of a still-growing fence), so there's no "the initial value is exempt from
 * debouncing" case. After that first settle, a further change keeps returning the previous
 * settled value (no flicker back to `undefined`) until the new value has itself been stable for
 * `delayMs`. Every change to `value` (or the initial mount) restarts the `delayMs` timer. */
export function useDebouncedValue<T>(value: T, delayMs: number): T | undefined {
  const [settled, setSettled] = useState<T | undefined>(undefined);

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return settled;
}
