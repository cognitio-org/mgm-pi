import { useState } from "react";
import { isSoundEnabled, setSoundEnabled } from "../lib/floppy-sound.ts";

/** Header control for the optional floppy-drive sound (src/lib/floppy-sound.ts). Off by default;
 * toggling only flips the persisted preference -- it never plays audio itself, since starting
 * audio outside a request the user just triggered would defeat the "always follows a user
 * gesture" rule the sound is built around. `compact` drops the text label for tight spaces (the
 * desktop header, the desk menu bar). */
export function SoundToggle({ compact }: { compact?: boolean } = {}) {
  const [enabled, setEnabled] = useState(() => isSoundEnabled());

  function toggle() {
    const next = !enabled;
    setEnabled(next);
    setSoundEnabled(next);
  }

  const label = enabled ? "Floppy sound on (click to mute)" : "Floppy sound off (click to enable)";

  return (
    <button
      type="button"
      className={`theme-toggle${compact ? " icon-toggle" : ""}`}
      onClick={toggle}
      aria-pressed={enabled}
      aria-label={`Floppy drive sound: ${enabled ? "on" : "off"}`}
      title={label}
    >
      {compact ? "♪" : enabled ? "♪ ON" : "♪ OFF"}
    </button>
  );
}
