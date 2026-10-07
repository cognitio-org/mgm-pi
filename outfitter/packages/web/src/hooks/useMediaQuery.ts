import { useEffect, useState } from "react";

/** Whether a media query matches now, following changes (a rotated phone, a resized window). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/** #498: below this the session page is a phone layout: the Disk Box is its own screen and the
 * floppy fills the window. */
export const PHONE_QUERY = "(max-width: 719.98px)";

/** #498 review: wide enough that the Details pane opens by default (until the person chooses). */
export const WIDE_QUERY = "(min-width: 1280px)";
