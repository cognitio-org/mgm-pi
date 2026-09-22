import { Link } from "react-router-dom";
import { useProviders } from "../hooks/useProviders.ts";

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

/** Header strip for the providers/peripherals dashboard (E3.6). Renders one pill per provider on
 * desktop; on narrow screens (see styles/layout.css) that row collapses to a single "N/M up"
 * summary pill, coloured by the worst status present, linking to /providers -- see mobile-desk.md
 * part 1. Renders nothing while loading or on a 404 (endpoint not built yet). */
export function ProviderStrip() {
  const { providers, loaded } = useProviders();
  if (!loaded || providers.length === 0) return null;

  const up = providers.filter((p) => p.status === "up").length;
  const worst = worstStatus(providers.map((p) => p.status));

  return (
    <>
      <div className="provider-strip-full">
        {providers.map((p) => (
          <span key={p.id} className={`status-pill ${p.status}`} title={p.detail ?? p.name}>
            {p.name}
          </span>
        ))}
      </div>
      <Link
        to="/providers"
        className={`status-pill provider-strip-summary ${worst}`}
        title={`${vocabHint(providers.length)} ${up}/${providers.length} peripherals up`}
      >
        {up}/{providers.length} up
      </Link>
    </>
  );
}

function vocabHint(count: number): string {
  return count === 1 ? "Peripheral:" : "Peripherals:";
}
