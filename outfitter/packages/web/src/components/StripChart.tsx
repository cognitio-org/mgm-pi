import type { SandboxSeries } from "../api/client.ts";
import { chartGeometry } from "../lib/nerd-out.ts";

const WIDTH = 240;
const HEIGHT = 56;

/**
 * One stats series as a small strip chart (#198): a stepped phosphor line over a dotted grid, with
 * an optional dashed limit line. The heading carries the numbers, so the chart itself is
 * decoration for screen readers beyond its one-line label.
 */
export function StripChart({
  label,
  series,
  format,
  limit,
  limitLabel,
}: {
  label: string;
  series: SandboxSeries;
  format: (value: number) => string;
  limit?: number;
  limitLabel?: string;
}) {
  const geo = chartGeometry(series, WIDTH, HEIGHT, limit);
  const peak = series.reduce((m, [, v]) => Math.max(m, v), 0);
  const summary =
    geo.last === undefined
      ? `${label}: no samples yet`
      : `${label}: now ${format(geo.last)}, peak ${format(peak)}${limit ? `, limit ${format(limit)}` : ""}`;
  return (
    <figure className="strip-chart">
      <figcaption className="strip-chart-caption">
        <span className="strip-chart-label">{label}</span>
        {geo.last === undefined ? (
          <span className="strip-chart-value">--</span>
        ) : (
          <span className="strip-chart-value">
            {format(geo.last)}
            <span className="strip-chart-peak"> peak {format(peak)}</span>
          </span>
        )}
      </figcaption>
      <svg
        className="strip-chart-plot"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={summary}
      >
        {geo.area && <path className="strip-chart-area" d={geo.area} />}
        {geo.limitY !== undefined && (
          <line className="strip-chart-limit" x1={0} x2={WIDTH} y1={geo.limitY} y2={geo.limitY} vectorEffect="non-scaling-stroke">
            {limitLabel && <title>{limitLabel}</title>}
          </line>
        )}
        {geo.path && <path className="strip-chart-line" d={geo.path} vectorEffect="non-scaling-stroke" />}
      </svg>
    </figure>
  );
}
