import { Link } from "react-router-dom";
import { useProviders } from "../hooks/useProviders.ts";
import type { ProviderRow } from "../api/client.ts";

/** Shown next to the sandbox provider new runs launch on, when more than one is registered (e.g.
 * GKE, with Cloud Run kept for runs it already started). */
export const DEFAULT_PROVIDER_TAG = "new runs";

/** A provider's name as the strip's popover shows it: the default sandbox provider tagged. */
export function providerLabel(p: Pick<ProviderRow, "name" | "isDefault">): string {
  return p.isDefault ? `${p.name} (${DEFAULT_PROVIDER_TAG})` : p.name;
}

const WORST_FIRST = ["down", "degraded", "unknown", "up"] as const;

/** The single class of the worst status present, for the mobile summary pill's colour --
 * "down" beats "degraded" beats "unknown" beats "up" so one failing peripheral is never hidden
 * behind a sea of healthy ones. */
export function worstStatus(statuses: string[]): (typeof WORST_FIRST)[number] {
  for (const s of WORST_FIRST) {
    if (statuses.includes(s)) return s;
  }
  return "up";
}

/** Header strip for the providers/peripherals dashboard (E3.6). Always renders as a single
 * "N/M up" summary pill (coloured by the worst status present) so it holds to one row at any
 * header width -- a fixed four-pill-wide row doesn't scale as more peripherals are configured,
 * and was the thing that made the desktop header wrap at ~1100-1200px. Hovering or focusing the
 * pill expands a popover with the full per-provider list (mouse and keyboard both -- `:hover` and
 * `:focus-within` in styles/layout.css); clicking/Entering the pill itself still navigates to
 * /providers. Renders nothing while loading or on a 404 (endpoint not built yet). */
export function ProviderStrip() {
  const { providers, loaded } = useProviders();
  if (!loaded || providers.length === 0) return null;

  const up = providers.filter((p) => p.status === "up").length;
  const worst = worstStatus(providers.map((p) => p.status));

  return (
    <div className="provider-strip">
      <Link
        to="/providers"
        className={`status-pill provider-strip-summary ${worst}`}
        title={`${vocabHint(providers.length)} ${up}/${providers.length} up -- hover or focus for details`}
      >
        {up}/{providers.length} up
      </Link>
      <div className="provider-strip-popover" role="group" aria-label="Peripheral status">
        {providers.map((p) => (
          <span key={p.id} className={`status-pill ${p.status}`} title={p.detail ?? p.name}>
            {providerLabel(p)}
          </span>
        ))}
      </div>
    </div>
  );
}

function vocabHint(count: number): string {
  return count === 1 ? "Peripheral:" : "Peripherals:";
}
