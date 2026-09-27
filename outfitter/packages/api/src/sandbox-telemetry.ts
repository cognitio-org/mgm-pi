// Sandbox logs and stats for the session page (#196, #197).
//
// Logs come from Cloud Logging's `outfitter-sandboxes` log bucket, which a sink fills with agentd's
// lines only (deploy/gke-iam.sh: the sandbox namespace's agentd containers and the Cloud Run agent
// job). It is the only log data outfitter-api@ can read: its grant is roles/logging.viewAccessor
// conditioned on that bucket's _AllLogs view. agentd logs every line with `runId` in jsonPayload on
// both providers, so a run's lines are one filter away. Stats come from Cloud Monitoring's GKE
// container metrics for the run's pod.
//
// The lines are untrusted text. Some are the model's own output, and any sandbox can write log
// entries through its service account's logWriter (Cloud Run needs it), including ones claiming
// another run's id (#201 security review). The page shows them as plain text, labelled as such.
//
// Everything a caller passes ends up inside a Logging or Monitoring filter, so both inputs are
// checked against a strict shape first (a run id is a UUID, a pod name a DNS label) and nothing
// else from a request reaches a filter. Callers also check the run belongs to the session.

export interface SandboxLogLine {
  time: string;
  severity: string;
  message: string;
}

export interface SandboxLogPage {
  /** Oldest first within the page. */
  lines: SandboxLogLine[];
  /** Pass back for the next, older page. Absent at the start of the run's logs. */
  nextPageToken?: string;
  /** The pod the run's lines came from (GKE), from the entries' own resource labels. */
  podName?: string;
}

/** [ISO time, value] points, oldest first. */
export type Series = [string, number][];

export interface SandboxMetrics {
  memoryMb: Series;
  cpuCores: Series;
  diskMb: Series;
}

/** Why a telemetry call has nothing to return: not set up (dev, a deployment without the grants),
 * or the backend refused or failed. Never a stack trace or a Google error body. */
export class TelemetryUnavailable extends Error {
  /** `bad-request`: the caller's own input (a malformed page token), not the backend. */
  readonly kind: "not-configured" | "forbidden" | "failed" | "bad-request";

  constructor(kind: "not-configured" | "forbidden" | "failed" | "bad-request", message: string) {
    super(message);
    this.name = "TelemetryUnavailable";
    this.kind = kind;
  }
}

export interface SandboxTelemetry {
  logs(runId: string, opts?: { pageToken?: string; pageSize?: number }): Promise<SandboxLogPage>;
  metrics(podName: string, start: Date, end: Date): Promise<SandboxMetrics>;
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POD_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
/** Page tokens are opaque base64-ish strings from Logging; anything else is refused. */
const PAGE_TOKEN = /^[A-Za-z0-9_\-+/=.]{1,2048}$/;

export function isRunId(value: string): boolean {
  return RUN_ID.test(value);
}

export function isPodName(value: string): boolean {
  return POD_NAME.test(value);
}

/** The log bucket deploy/gke-iam.sh creates and fills; its _AllLogs view is the one resource
 * outfitter-api@ may read logs through. */
export const SANDBOX_LOG_BUCKET_ID = "outfitter-sandboxes";

export function sandboxLogViewName(project: string): string {
  return `projects/${project}/locations/global/buckets/${SANDBOX_LOG_BUCKET_ID}/views/_AllLogs`;
}

/** A log line is shown whole up to this many characters; pi's start-up timing dumps run longer. */
const MAX_LINE_CHARS = 4000;
const MAX_PAGE = 200;

interface LogEntryWire {
  timestamp?: string;
  severity?: string;
  textPayload?: string;
  jsonPayload?: { message?: unknown };
  resource?: { labels?: Record<string, string> };
}

export function toLogPage(body: { entries?: LogEntryWire[]; nextPageToken?: string }): SandboxLogPage {
  const entries = body.entries ?? [];
  const podName = entries.map((e) => e.resource?.labels?.pod_name).find((name): name is string => !!name && isPodName(name));
  const lines = entries
    .map((entry) => {
      const raw = typeof entry.jsonPayload?.message === "string" ? entry.jsonPayload.message : (entry.textPayload ?? "");
      const message = raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}… [truncated]` : raw;
      return { time: entry.timestamp ?? "", severity: entry.severity ?? "DEFAULT", message };
    })
    .reverse(); // Logging returns newest first; a page reads oldest first
  return { lines, ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}), ...(podName ? { podName } : {}) };
}

interface TimeSeriesWire {
  metric?: { labels?: Record<string, string> };
  points?: { interval?: { endTime?: string }; value?: { int64Value?: string; doubleValue?: number } }[];
}

/** One series' points, oldest first, scaled. Sums series that share a timestamp (e.g. several
 * containers' disk use in one pod). */
export function toSeries(body: { timeSeries?: TimeSeriesWire[] }, scale: number): Series {
  const byTime = new Map<string, number>();
  for (const series of body.timeSeries ?? []) {
    for (const point of series.points ?? []) {
      const time = point.interval?.endTime;
      const raw = point.value?.doubleValue ?? (point.value?.int64Value !== undefined ? Number(point.value.int64Value) : undefined);
      if (!time || raw === undefined || !Number.isFinite(raw)) continue;
      byTime.set(time, (byTime.get(time) ?? 0) + raw * scale);
    }
  }
  return [...byTime.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([t, v]) => [t, Math.round(v * 1000) / 1000]);
}

type Request = <T>(opts: { url: string; method?: "GET" | "POST"; data?: unknown; params?: Record<string, string> }) => Promise<{ data: T }>;

/** Production: Cloud Logging and Monitoring over REST with outfitter-api@'s ADC. */
export class GcpSandboxTelemetry implements SandboxTelemetry {
  private clientPromise: Promise<{ request: Request }> | undefined;
  private readonly project: string;
  private readonly namespace: string;
  private readonly client: { request: Request } | undefined;

  /** `namespace` is config.gkeNamespace (GKE_NAMESPACE), the only namespace metrics are read from. */
  constructor(project: string, namespace: string, client?: { request: Request }) {
    if (!isPodName(namespace)) throw new Error(`GKE namespace "${namespace}" is not a Kubernetes name`);
    this.project = project;
    this.namespace = namespace;
    this.client = client;
  }

  private async http(): Promise<{ request: Request }> {
    if (this.client) return this.client;
    this.clientPromise ??= (async () => {
      const { GoogleAuth } = await import("google-auth-library");
      const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
      return (await auth.getClient()) as unknown as { request: Request };
    })();
    return this.clientPromise;
  }

  async logs(runId: string, opts: { pageToken?: string; pageSize?: number } = {}): Promise<SandboxLogPage> {
    if (!isRunId(runId)) throw new TelemetryUnavailable("bad-request", "not a run id");
    if (opts.pageToken !== undefined && !PAGE_TOKEN.test(opts.pageToken)) {
      throw new TelemetryUnavailable("bad-request", "not a page token from this endpoint");
    }
    const pageSize = Math.min(Math.max(opts.pageSize ?? 100, 1), MAX_PAGE);
    const body = await this.call<{ entries?: LogEntryWire[]; nextPageToken?: string }>({
      url: "https://logging.googleapis.com/v2/entries:list",
      method: "POST",
      data: {
        resourceNames: [sandboxLogViewName(this.project)],
        filter: `jsonPayload.runId="${runId}"`,
        orderBy: "timestamp desc",
        pageSize,
        ...(opts.pageToken ? { pageToken: opts.pageToken } : {}),
      },
    });
    return toLogPage(body);
  }

  async metrics(podName: string, start: Date, end: Date): Promise<SandboxMetrics> {
    if (!isPodName(podName)) throw new TelemetryUnavailable("bad-request", "not a pod name");
    const where = `resource.labels.namespace_name="${this.namespace}" AND resource.labels.pod_name="${podName}"`;
    const query = (metric: string, aligner: string, extra = "") =>
      this.call<{ timeSeries?: TimeSeriesWire[] }>({
        url: `https://monitoring.googleapis.com/v3/projects/${this.project}/timeSeries`,
        params: {
          filter: `metric.type="${metric}" AND ${where}${extra}`,
          "interval.startTime": start.toISOString(),
          "interval.endTime": end.toISOString(),
          "aggregation.alignmentPeriod": "60s",
          "aggregation.perSeriesAligner": aligner,
        },
      });
    const [memory, cpu, disk] = await Promise.all([
      // non-evictable only: what counts toward the OOM kill (#187).
      query("kubernetes.io/container/memory/used_bytes", "ALIGN_MAX", ' AND metric.labels.memory_type="non-evictable"'),
      query("kubernetes.io/container/cpu/core_usage_time", "ALIGN_RATE"),
      query("kubernetes.io/container/ephemeral_storage/used_bytes", "ALIGN_MAX"),
    ]);
    const MIB = 1 / (1024 * 1024);
    return { memoryMb: toSeries(memory, MIB), cpuCores: toSeries(cpu, 1), diskMb: toSeries(disk, MIB) };
  }

  private async call<T>(opts: Parameters<Request>[0]): Promise<T> {
    try {
      return (await (await this.http()).request<T>(opts)).data;
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 403) {
        throw new TelemetryUnavailable("forbidden", "outfitter-api@ can't read this yet (deploy/gke-iam.sh grants it)");
      }
      // Log the status only: a Google error body can echo the request.
      console.warn(`[telemetry] request failed${status ? ` (${status})` : ""}`);
      throw new TelemetryUnavailable("failed", status ? `the telemetry backend answered ${status}` : "the telemetry backend didn't answer");
    }
  }
}

/** Holds each answer for `ttlMs`, keyed by the call's exact arguments, so a page that polls, or
 * several open tabs, costs Cloud Logging's ~60 reads/min project quota once per window rather than
 * once per request (#201 security review). Failures aren't cached. Bounded: the oldest entry goes
 * once `maxEntries` is reached. */
export class CachedSandboxTelemetry implements SandboxTelemetry {
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();
  private readonly inner: SandboxTelemetry;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(inner: SandboxTelemetry, ttlMs = 20_000, maxEntries = 500, now: () => number = Date.now) {
    this.inner = inner;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
  }

  logs(runId: string, opts: { pageToken?: string; pageSize?: number } = {}): Promise<SandboxLogPage> {
    return this.cached(JSON.stringify(["logs", runId, opts.pageToken ?? null, opts.pageSize ?? null]), () => this.inner.logs(runId, opts));
  }

  metrics(podName: string, start: Date, end: Date): Promise<SandboxMetrics> {
    // Minute-aligned end: a live run's window moves every request, and the points are per minute.
    const endKey = Math.floor(end.getTime() / 60_000);
    return this.cached(JSON.stringify(["metrics", podName, start.getTime(), endKey]), () => this.inner.metrics(podName, start, end));
  }

  private cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(key, { at: this.now(), value });
    // Only drop our own entry: a slow load that fails after a newer one replaced it must not evict
    // the newer answer (#201 re-review).
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    if (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
    return value;
  }
}

/** Dev and tests: nothing configured. */
export class NoSandboxTelemetry implements SandboxTelemetry {
  async logs(): Promise<SandboxLogPage> {
    throw new TelemetryUnavailable("not-configured", "sandbox logs aren't set up on this deployment");
  }

  async metrics(): Promise<SandboxMetrics> {
    throw new TelemetryUnavailable("not-configured", "sandbox stats aren't set up on this deployment");
  }
}
