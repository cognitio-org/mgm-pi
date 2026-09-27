import { useEffect, useState } from "react";
import { api, type SandboxDetail, type SandboxMetrics, type StartupSummary } from "../api/client.ts";
import {
  exitSummary,
  formatClock,
  formatMb,
  formatStamp,
  detailMessage,
  providerLabel,
  shortImage,
  telemetryMessage,
} from "../lib/nerd-out.ts";
import { formatSeconds, startupSource } from "./StartupTime.tsx";
import { StripChart } from "./StripChart.tsx";
import { LogViewerDialog } from "./LogViewerDialog.tsx";

/** While the run is live the details (heartbeat memory, the pod) are re-read this often. */
export const DETAIL_POLL_MS = 15_000;
/** And the stats history, which Cloud Monitoring keeps per minute. */
export const METRICS_POLL_MS = 60_000;

/** The run can still have a sandbox: anything short of stopped or failed, queued and provisioning
 * included (unlike StartupTime's LIVE_STATES, which is about a finished start being current). The
 * api's routes/sandbox.ts isActive draws the same line. */
export function isLiveRun(state: string): boolean {
  return state !== "stopped" && state !== "failed";
}

function formatCores(cores: number): string {
  return cores < 0.1 && cores > 0 ? "<0.1 cores" : `${cores.toFixed(cores < 10 ? 2 : 1)} cores`;
}

/** A spec-sheet row: a label, a dotted leader, the value. Omitted when there's no value. */
function Spec({ label, children, title, tone }: { label: string; children: React.ReactNode; title?: string; tone?: "ok" | "danger" }) {
  if (children === undefined || children === null || children === "") return null;
  return (
    <div className="spec-row">
      <dt>{label}</dt>
      <dd className={tone ? `is-${tone}` : undefined} title={title}>
        {children}
      </dd>
    </div>
  );
}

/**
 * The "nerd out" panel (#198): a run's drive -- where it ran, its memory against the limit, its
 * stats history, how it ended -- and a button to its log. The home for operational details on the
 * session page. Opened from the status bar; nothing here is fetched until it opens, and the log
 * only when asked for.
 */
export function NerdOutPanel({
  sessionId,
  runState,
  startup,
  onClose,
}: {
  sessionId: string;
  /** The stream's run state: a change re-reads the details. */
  runState: string | undefined;
  startup: StartupSummary | null | undefined;
  onClose: () => void;
}) {
  /** Undefined: the api's pick (the active run, else the latest). */
  const [pickedRun, setPickedRun] = useState<string | undefined>(undefined);
  const [detail, setDetail] = useState<SandboxDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<SandboxMetrics | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  /** The pick changed and its details haven't arrived: what's shown is still the previous run. */
  const [switching, setSwitching] = useState(false);

  const runId = detail?.run.id;
  const live = detail ? isLiveRun(detail.run.state) : false;
  const gke = detail?.run.provider === "gke";

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .sandbox(sessionId, pickedRun)
        .then((d) => {
          if (cancelled) return;
          setDetail(d);
          setDetailError(null);
          setSwitching(false);
        })
        .catch((err) => {
          if (cancelled) return;
          setDetailError(detailMessage(err, pickedRun === undefined));
          setSwitching(false);
        });
    void load();
    return () => {
      cancelled = true;
    };
  }, [sessionId, pickedRun, runState]);

  // Poll while the run shown is live.
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      api
        .sandbox(sessionId, runId)
        .then((d) => setDetail((cur) => (cur?.run.id === d.run.id ? d : cur)))
        .catch(() => {});
    }, DETAIL_POLL_MS);
    return () => clearInterval(timer);
  }, [sessionId, runId, live]);

  // A different run's history starts empty. Not on `live` flipping: the run that just ended keeps
  // its charts (an OOM kill's climb is what the person came to see).
  useEffect(() => {
    setMetrics(null);
    setMetricsError(null);
  }, [sessionId, runId]);

  useEffect(() => {
    if (!runId || !gke) return;
    let cancelled = false;
    const load = () =>
      api
        .sandboxMetrics(sessionId, runId)
        .then((m) => {
          if (cancelled) return;
          setMetrics(m);
          setMetricsError(null);
        })
        .catch((err) => {
          if (!cancelled) setMetricsError(telemetryMessage(err, "Stats history"));
        });
    void load();
    const timer = live ? setInterval(load, METRICS_POLL_MS) : undefined;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [sessionId, runId, gke, live]);

  const run = detail?.run;
  const ownStartup = startup && run && startup.runId === run.id ? startup : undefined;
  const provider = run ? (ownStartup ? startupSource(ownStartup) : "") || providerLabel(run.provider) : undefined;
  const exit = detail?.exit ?? detail?.live?.exit;
  const ended = exit ? exitSummary(exit) : undefined;
  const mem = detail?.memory ?? {};
  const memPercent = mem.lastMb !== undefined && mem.limitMb ? (mem.lastMb / mem.limitMb) * 100 : undefined;
  const memLimitMb = mem.limitMb;
  const res = detail?.live?.resources;

  return (
    <section className="panel nerd-out" aria-label="Nerd out">
      <div className="panel-titlebar nerd-out-titlebar">
        <span className="panel-label">Nerd out</span>
        {detail && detail.runs.length > 1 && (
          <select
            className="nerd-out-run-picker"
            aria-label="Run"
            value={pickedRun ?? ""}
            onChange={(e) => {
              setLogsOpen(false);
              setSwitching(true);
              // "" is the latest run, followed as new runs start; an id pins that run.
              setPickedRun(e.target.value || undefined);
            }}
          >
            <option value="">Latest run</option>
            {detail.runs.map((r) => (
              <option key={r.id} value={r.id}>
                {formatStamp(r.createdAt)} · {r.state}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="btn btn-small nerd-out-close" onClick={onClose} aria-label="Close the nerd out panel">
          ✕
        </button>
      </div>
      <div className="nerd-out-body">
        {!detail && !detailError && <p className="nerd-out-note">LOADING…</p>}
        {detailError && !detail && <p className="nerd-out-note">{detailError}</p>}
        {detail && run && (
          <>
            <div className="nerd-out-grid">
              <section className="nerd-out-card" aria-labelledby="nerd-out-drive">
                <h3 id="nerd-out-drive" className="nerd-out-card-title">
                  Drive
                </h3>
                <dl className="spec">
                  <Spec label="Run" title={run.id}>
                    <span className="mono">{run.id.slice(0, 8)}</span> · {run.state}
                  </Spec>
                  <Spec label="Provider">{provider}</Spec>
                  <Spec label="Started">{formatStamp(run.createdAt)}</Spec>
                  {ownStartup?.complete && <Spec label="Start-up">{formatSeconds(ownStartup.totalMs)}</Spec>}
                  <Spec label="Last seen">{run.lastSeenAt ? formatClock(run.lastSeenAt) : undefined}</Spec>
                  <Spec label="Pod" title={detail.live?.name}>
                    {detail.live?.name}
                  </Spec>
                  <Spec label="Node" title={detail.live?.node}>
                    {detail.live?.node}
                  </Spec>
                  <Spec label="Image" title={detail.live?.image}>
                    {detail.live?.image ? shortImage(detail.live.image) : undefined}
                  </Spec>
                  <Spec label="Phase">{detail.live?.phase}</Spec>
                  <Spec label="Limits">
                    {res ? [res.cpu && `${res.cpu} cpu`, res.memory && `${res.memory} mem`, res.ephemeralStorage && `${res.ephemeralStorage} disk`].filter(Boolean).join(" · ") : undefined}
                  </Spec>
                  <Spec label="Ended" tone={ended?.tone}>
                    {ended?.text}
                  </Spec>
                  <Spec label="Reason">{run.reason}</Spec>
                </dl>
              </section>

              <section className="nerd-out-card" aria-labelledby="nerd-out-memory">
                <h3 id="nerd-out-memory" className="nerd-out-card-title">
                  Memory{live ? <span className="nerd-out-live"> live</span> : null}
                </h3>
                {mem.lastMb === undefined ? (
                  <p className="nerd-out-note">No heartbeat report{live ? " yet" : ""}.</p>
                ) : (
                  <>
                    <p className="nerd-out-big mono">
                      {formatMb(mem.lastMb)}
                      {memLimitMb ? <span className="nerd-out-dim"> / {formatMb(memLimitMb)}</span> : null}
                    </p>
                    {memPercent !== undefined && (
                      <span
                        className={`meter nerd-out-meter${memPercent >= 90 ? " meter-danger" : memPercent >= 80 ? " meter-warn" : ""}`}
                        role="meter"
                        aria-label="Drive memory used"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(memPercent)}
                      >
                        <span className="meter-fill" style={{ width: `${Math.min(100, Math.max(0, memPercent))}%` }} />
                      </span>
                    )}
                    {mem.peakMb !== undefined && <p className="nerd-out-note mono">peak {formatMb(mem.peakMb)}</p>}
                  </>
                )}
              </section>

              <section className="nerd-out-card nerd-out-history" aria-labelledby="nerd-out-history">
                <h3 id="nerd-out-history" className="nerd-out-card-title">
                  History
                </h3>
                {!gke ? (
                  <p className="nerd-out-note">Stats history is kept for GKE drives only.</p>
                ) : metricsError && !metrics ? (
                  <p className="nerd-out-note">{metricsError}</p>
                ) : !metrics ? (
                  <p className="nerd-out-note">LOADING…</p>
                ) : !metrics.podName ? (
                  <p className="nerd-out-note">No samples yet. Cloud Monitoring lags a minute or two.</p>
                ) : (
                  <div className="strip-charts">
                    <StripChart
                      label="Mem"
                      series={metrics.series.memoryMb}
                      format={formatMb}
                      limit={memLimitMb}
                      limitLabel={memLimitMb ? `limit ${formatMb(memLimitMb)}` : undefined}
                    />
                    <StripChart label="CPU" series={metrics.series.cpuCores} format={formatCores} />
                    <StripChart label="Disk" series={metrics.series.diskMb} format={formatMb} />
                  </div>
                )}
              </section>
            </div>
            <div className="nerd-out-actions">
              <button type="button" className="btn" onClick={() => setLogsOpen(true)} disabled={switching}>
                View logs
              </button>
              {detailError && <span className="nerd-out-note">{detailError}</span>}
            </div>
          </>
        )}
      </div>
      {logsOpen && run && (
        <LogViewerDialog key={run.id} sessionId={sessionId} runId={run.id} live={live} onClose={() => setLogsOpen(false)} />
      )}
    </section>
  );
}
