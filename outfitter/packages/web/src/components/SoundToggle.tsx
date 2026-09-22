import { useState } from "react";
import { isSoundEnabled, setSoundEnabled } from "../lib/floppy-sound.ts";

/** Header control for the optional floppy-drive sound (src/lib/floppy-sound.ts). Off by default;
 * toggling only flips the persisted preference -- it never plays audio itself, since starting
 * audio outside a request the user just triggered would defeat the "always follows a user
 * gesture" rule the sound is built around. */
export function SoundToggle() {
  const [enabled, setEnabled] = useState(() => isSoundEnabled());

  function toggle() {
    const next = !enabled;
    setEnabled(next);
    setSoundEnabled(next);
  }

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-pressed={enabled}
      aria-label={`Floppy drive sound: ${enabled ? "on" : "off"}`}
      title={enabled ? "Floppy sound on (click to mute)" : "Floppy sound off (click to enable)"}
    >
      {enabled ? "♪ ON" : "♪ OFF"}
    </button>
  );
}
