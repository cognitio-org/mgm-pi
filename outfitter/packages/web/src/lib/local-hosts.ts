// Pure helpers for the Modems page (#388) and the account/settings remove list (#385).
// The listing shape is GET /api/local-hosts; this file does not invent fields.

export function anyHostOnline(hosts: readonly { status: string }[]): boolean {
  return hosts.some((h) => h.status === "online");
}

/** Own hosts stay first (the api lists them first); other owners follow in first-seen order. */
export function groupHostsByOwner<T extends { owner: { email: string } }>(hosts: readonly T[]): { email: string; hosts: T[] }[] {
  const order: string[] = [];
  const map = new Map<string, T[]>();
  for (const h of hosts) {
    const email = h.owner.email;
    let list = map.get(email);
    if (!list) {
      list = [];
      map.set(email, list);
      order.push(email);
    }
    list.push(h);
  }
  return order.map((email) => ({ email, hosts: map.get(email)! }));
}

/** Loaded means in memory now. Anything else (false or unknown) is not loaded. */
export function partitionModels<T extends { loaded?: boolean }>(models: readonly T[]): { loaded: T[]; notLoaded: T[] } {
  const loaded: T[] = [];
  const notLoaded: T[] = [];
  for (const m of models) (m.loaded === true ? loaded : notLoaded).push(m);
  return { loaded, notLoaded };
}

export function hostStatusLabel(status: string): string {
  return status === "not-sharing" ? "not sharing" : status;
}

/** CSS class on `.status-pill`. Unknown statuses read as offline. */
export function hostStatusClass(status: string): string {
  if (status === "online" || status === "stale" || status === "not-sharing" || status === "revoked") return status;
  return "offline";
}

export function formatContext(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return "—";
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function yesNo(v: boolean | undefined): string {
  if (v === true) return "yes";
  if (v === false) return "no";
  return "—";
}
