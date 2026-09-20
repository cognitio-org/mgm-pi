export function StatusPill({ state }: { state?: string }) {
  const label = state ?? "stopped";
  return <span className={`status-pill ${label}`}>{label}</span>;
}
