// #257: how voice spend reads on screen. Deepgram bills fractions of a cent per minute, so small
// sums show as "<$0.01" rather than a misleading "$0.00".

export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0.00";
  if (usd < 0.005) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

export function formatMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0 min";
  if (minutes < 1) return "<1 min";
  if (minutes < 120) return `${Math.round(minutes)} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}
