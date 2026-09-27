// Pure helpers for the providers/peripherals dashboard (ProviderStrip, ProvidersPage).
import type { ProviderRow } from "../api/client.ts";

type Status = ProviderRow["status"];

const WORST_FIRST = ["down", "degraded", "unknown", "up"] as const;

/** Kinds that come from the sandbox capacity probes (one row per registered cloud provider). */
const SANDBOX_KINDS = new Set(["cloudrun", "gke"]);

/** Tag on the sandbox provider new runs launch on (the row's `isDefault`). The API only sets that
 * on a cloud default, so a local dev deployment shows no tag. */
export const DEFAULT_PROVIDER_TAG = "new runs";

/** Whether new runs on a sandbox provider start warm right now. */
export interface SandboxWarmth {
  /** warm: a ready pool pod is waiting. warming: the pool is on but has none ready yet, so the next
   * run starts cold. cold: the pool is off (scaled to 0 outside its hours) or launch mode is cold. */
  mode: "warm" | "warming" | "cold";
  /** One line for the Peripherals page. */
  detail: string;
}

/** GKE rows only, from the capacity probe: launch mode and the warm pool's size together. Warm
 * launch mode alone isn't enough -- the pool is only scaled up for its scheduled hours, and outside
 * them every run starts cold. null when the row doesn't say (not GKE, probe down, older api). */
export function sandboxWarmth(p: Pick<ProviderRow, "kind" | "status" | "meta">): SandboxWarmth | null {
  if (p.kind !== "gke" || p.status !== "up" || !p.meta?.launchMode) return null;
  const { launchMode, warmReady = 0, warmDesired } = p.meta;
  if (launchMode === "cold") return { mode: "cold", detail: "Cold: launch mode is cold" };
  if (warmDesired === undefined) return { mode: "cold", detail: "Cold: no warm pool" };
  if (warmDesired === 0) return { mode: "cold", detail: "Cold: warm pool scaled to 0" };
  if (warmReady > 0) return { mode: "warm", detail: `Warm: ${warmReady} of ${warmDesired} ready` };
  return { mode: "warming", detail: `Warming: 0 of ${warmDesired} ready, the next run starts cold` };
}

/** A provider's name as the strip's popover shows it: the default sandbox provider tagged, and a
 * GKE row's warmth when the probe reports it. */
export function providerLabel(p: Pick<ProviderRow, "name" | "isDefault"> & Partial<Pick<ProviderRow, "kind" | "status" | "meta">>): string {
  const warmth = p.kind && p.status ? sandboxWarmth({ kind: p.kind, status: p.status, meta: p.meta }) : null;
  const tags = [p.isDefault ? DEFAULT_PROVIDER_TAG : null, warmth?.mode ?? null].filter(Boolean);
  return tags.length > 0 ? `${p.name} (${tags.join(" · ")})` : p.name;
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
