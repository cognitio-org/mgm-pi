// Pure helpers for the providers/peripherals dashboard (ProviderStrip, ProvidersPage).
import type { ProviderRow } from "../api/client.ts";

type Status = ProviderRow["status"];

const WORST_FIRST = ["down", "degraded", "unknown", "up"] as const;

/** Kinds that come from the sandbox capacity probes (one row per registered cloud provider). */
const SANDBOX_KINDS = new Set(["cloudrun", "gke"]);

/** Tag on the sandbox provider new runs launch on (the row's `isDefault`). The API only sets that
 * on a cloud default, so a local dev deployment shows no tag. */
export const DEFAULT_PROVIDER_TAG = "new runs";

/** A provider's name as the strip's popover shows it: the default sandbox provider tagged. */
export function providerLabel(p: Pick<ProviderRow, "name" | "isDefault">): string {
  return p.isDefault ? `${p.name} (${DEFAULT_PROVIDER_TAG})` : p.name;
}

/** The single class of the worst status present, for the mobile summary pill's colour --
 * "down" beats "degraded" beats "unknown" beats "up" so one failing peripheral is never hidden
 * behind a sea of healthy ones. */
export function worstStatus(statuses: string[]): (typeof WORST_FIRST)[number] {
  for (const s of WORST_FIRST) {
    if (statuses.includes(s)) return s;
  }
  return "up";
}

/** What a row contributes to the header's summary pill (#169 review). A sandbox provider that
 * isn't the default (Cloud Run, kept registered only so its leftover runs stay stoppable) caps at
 * "degraded": no new run uses it, so its being down shouldn't turn the pill red. Its own row
 * still shows its real status. */
export function summaryStatus(p: Pick<ProviderRow, "kind" | "status" | "isDefault">): Status {
  if (p.status === "down" && SANDBOX_KINDS.has(p.kind) && !p.isDefault) return "degraded";
  return p.status;
}
