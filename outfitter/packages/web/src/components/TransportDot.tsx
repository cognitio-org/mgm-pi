import type { LampTone } from "../lib/session-lamp.ts";

/** Lamp beside the run pill. `working` flickers like a drive LED; the other tones hold still.
 * Pass `label` when the lamp is the only thing saying it. Omit it when the words beside the
 * pill already say the same thing. */
export function TransportDot({ tone, label }: { tone: LampTone; label?: string }) {
  return (
    <span
      className={`transport-dot transport-dot-${tone}`}
      title={label}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}
