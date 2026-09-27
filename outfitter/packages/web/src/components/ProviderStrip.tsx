import { Link } from "react-router-dom";
import { useProviders } from "../hooks/useProviders.ts";
import { providerLabel, sandboxWarmth, summaryStatus, worstStatus } from "../lib/providers.ts";

/** Header strip for the providers/peripherals dashboard (E3.6). Always renders as a single
 * "N/M up" summary pill (coloured by the worst status present, per lib/providers.ts summaryStatus) so it holds to one row at any
 * header width -- a fixed four-pill-wide row doesn't scale as more peripherals are configured,
 * and was the thing that made the desktop header wrap at ~1100-1200px. Hovering or focusing the
 * pill expands a popover with the full per-provider list (mouse and keyboard both -- `:hover` and
 * `:focus-within` in styles/layout.css); clicking/Entering the pill itself still navigates to
 * /providers. Renders nothing while loading or on a 404 (endpoint not built yet). */
export function ProviderStrip() {
  const { providers, loaded } = useProviders();
  if (!loaded || providers.length === 0) return null;

  const up = providers.filter((p) => p.status === "up").length;
  const worst = worstStatus(providers.map(summaryStatus));

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
          <span key={p.id} className={`status-pill ${p.status}`} title={p.detail ?? sandboxWarmth(p)?.detail ?? p.name}>
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
