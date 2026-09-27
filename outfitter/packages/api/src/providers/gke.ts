// GKE Agent Sandbox provider (docs/specs/gke-sandbox-provider.md §4, gke-sandbox-provider-plan.md
// PR2). Starts/stops/status-checks a run's sandbox as a SandboxClaim against a warm pool -- never
// a SandboxTemplate directly (docs/reports/gke-spike.md's finding: "a SandboxClaim references a
// warm pool (spec.warmPoolRef, required), not a template. Cold claims go through a pool with
// replicas: 0" -- this supersedes the spec's §4.2 wording wherever the two differ).
//
// Transport (§4.1): no new dependency. `google-auth-library` (already in package.json, imported
// lazily here exactly like secrets.ts's GcpSecretAdmin) mints an access token with GKE_TOKEN_SCOPES
// (cloud-platform + userinfo.email); plain
// `fetch` talks to the cluster's DNS-based control-plane endpoint (a *.gke.goog host, publicly
// trusted per spike S6 -- no cluster CA handling). `@kubernetes/client-node` would be a large
// dependency for four REST verbs on three resources.
//
// Every CRD group/version/resource path and field name lives in the constants below, per the
// spec's own risk note (§8.1: "Agent Sandbox is still v1beta1 ... keep every CRD path and field in
// constants. The contract suite catches drift").

import type {
  RunLaunch,
  SandboxCapacity,
  SandboxExit,
  SandboxHandle,
  SandboxInfo,
  SandboxProvider,
  SandboxStartResult,
  SandboxStatus,
} from "@outfitter/provider-local";
import type { GkeLaunchMode } from "../config.ts";

/** OAuth scopes for the access token the API presents to the cluster's DNS endpoint. userinfo.email
 * is required, not optional: without it GKE authenticates a Google service account by its numeric
 * unique ID ("109876399607867997839"), not its email, so deploy/gke/rbac.yaml's RoleBinding for
 * `User: outfitter-api@...` never matches and every call is 403 Forbidden. Seen live on 2026-09-24:
 * Cloud Run's metadata server mints exactly the scopes requested, and this provider asked for
 * cloud-platform only, so the first warm-pool hook call was refused (GKE audit log: `User "109876399607867997839" cannot patch ... sandboxwarmpools`).
 * Spike S6 missed it because gcloud's impersonated token carries the email scope by default. */
export const GKE_TOKEN_SCOPES: readonly string[] = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
];

// ---------- CRD constants (kubernetes-sigs/agent-sandbox v1.0.3) ----------

const EXTENSIONS_API = "extensions.agents.x-k8s.io/v1beta1";
const SANDBOXES_API = "agents.x-k8s.io/v1beta1";

const CLAIMS_RESOURCE = "sandboxclaims";
const WARM_POOLS_RESOURCE = "sandboxwarmpools";
const SANDBOXES_RESOURCE = "sandboxes";

/** app.kubernetes.io/managed-by label value every claim this provider creates carries, so
 * capacity()'s LIST can select just ours (spec §4.2). */
const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
const MANAGED_BY_VALUE = "outfitter";
/** Shared name (PR3 depends on this exact string): the run-id label/annotation used both for
 * claim selection and, in warm mode, for the pod's downward-API assignment files. */
const RUN_ID_LABEL = "outfitter.dev/run-id";

const ANNOTATION_RUN_ID = "outfitter.dev/run-id";
const ANNOTATION_RUN_TOKEN = "outfitter.dev/run-token";
const ANNOTATION_API = "outfitter.dev/api";

const ENV_RUN_ID = "RUN_ID";
const ENV_RUN_TOKEN = "RUN_TOKEN";
const ENV_API = "OUTFITTER_API";

/** Claim lifecycle (spec §3.5): 24h hard timeout (parity with Cloud Run's --task-timeout=24h) and
 * a short GC window once the pod finishes. */
const CLAIM_SHUTDOWN_AFTER_MS = 24 * 60 * 60 * 1000;
const CLAIM_TTL_SECONDS_AFTER_FINISHED = 120;

/** §4.3: Ready=False reasons that mean the sandbox is gone, not still starting. */
const EXITED_READY_REASONS = new Set(["PodSucceeded", "PodFailed", "ClaimExpired", "SandboxSuspended"]);

/** §4.3, review finding M4: a claim can sit `Ready=False` for a reason that never resolves on its
 * own (ImagePullBackOff, unschedulable, AdoptionConflict...). The reconciler (runs.ts) skips
 * "starting" runs outright, so without a deadline a stuck claim would hold a GKE_MAX_ACTIVE slot
 * and block the session's wakes for up to the claim's 24h shutdownTime. 10 minutes matches
 * config.ts's own PROVISIONING_GRACE_MS default; S4's worst observed cold start (a brand new node,
 * first pull ever) was 145s. Past this, status() reports "unknown" instead of "starting", which the
 * reconciler treats like any other dead run: stop, then fail. */
const START_DEADLINE_MS = 10 * 60_000;

/** Review finding L2: every fetch (including endpoint discovery) is bounded, so a hung metadata
 * server or cluster doesn't wedge a wake or a reconcile tick forever. */
const FETCH_TIMEOUT_MS = 15_000;

/** §5.3 guardrail 3: the warm-pool hook clamps to this range; going higher needs a code change. */
export const WARM_POOL_MIN_REPLICAS = 0;
export const WARM_POOL_MAX_REPLICAS = 2;

function claimsPath(namespace: string): string {
  return `/apis/${EXTENSIONS_API}/namespaces/${namespace}/${CLAIMS_RESOURCE}`;
}

function claimPath(namespace: string, name: string): string {
  return `${claimsPath(namespace)}/${name}`;
}

function warmPoolPath(namespace: string, name: string): string {
  return `/apis/${EXTENSIONS_API}/namespaces/${namespace}/${WARM_POOLS_RESOURCE}/${name}`;
}

function sandboxPath(namespace: string, name: string): string {
  return `/apis/${SANDBOXES_API}/namespaces/${namespace}/${SANDBOXES_RESOURCE}/${name}`;
}

function podPath(namespace: string, name: string): string {
  return `/api/v1/namespaces/${namespace}/pods/${name}`;
}

/** agent-sandbox v1.0.3's resolvePodName (controllers/sandbox_controller.go): a Sandbox that adopted
 * a warm pod before the warm pool created full Sandbox CRs names its pod in this annotation;
 * otherwise the pod has the Sandbox's own name. */
const SANDBOX_POD_NAME_ANNOTATION = "agents.x-k8s.io/pod-name";

/** The container sandbox-template.yaml runs agentd in. */
const AGENT_CONTAINER = "agentd";

interface TerminatedState {
  reason?: string;
  exitCode?: number;
  finishedAt?: string;
  // `message` is deliberately not read: with terminationMessagePolicy File it is whatever the
  // container wrote to /dev/termination-log, i.e. text the untrusted model chose (PR #199 review).
}

/** Only the pod fields exitInfo reads. `pods: get` also exposes annotations, which hold a warm
 * run's token (#193): nothing here reads, returns or logs them. */
interface PodLike {
  metadata?: { name?: string };
  spec?: {
    nodeName?: string;
    containers?: {
      name?: string;
      image?: string;
      resources?: { limits?: { cpu?: string; memory?: string; "ephemeral-storage"?: string } };
    }[];
  };
  status?: {
    phase?: string;
    startTime?: string;
    containerStatuses?: {
      name?: string;
      state?: { terminated?: TerminatedState };
      lastState?: { terminated?: TerminatedState };
    }[];
  };
}

/** #197: the fields of a pod the session page shows. Deliberately a whitelist: metadata beyond the
 * name, env and annotations (a warm run's token) never leave this function. */
export function podInfo(pod: PodLike | null): SandboxInfo | undefined {
  if (!pod) return undefined;
  const container = pod.spec?.containers?.find((c) => c.name === AGENT_CONTAINER);
  const limits = container?.resources?.limits;
  const exit = podExit(pod);
  return {
    ...(pod.metadata?.name ? { name: pod.metadata.name } : {}),
    ...(pod.spec?.nodeName ? { node: pod.spec.nodeName } : {}),
    ...(container?.image ? { image: container.image } : {}),
    ...(pod.status?.phase ? { phase: pod.status.phase } : {}),
    ...(pod.status?.startTime ? { startedAt: pod.status.startTime } : {}),
    ...(limits
      ? {
          resources: {
            ...(limits.cpu ? { cpu: limits.cpu } : {}),
            ...(limits.memory ? { memory: limits.memory } : {}),
            ...(limits["ephemeral-storage"] ? { ephemeralStorage: limits["ephemeral-storage"] } : {}),
          },
        }
      : {}),
    ...(exit ? { exit } : {}),
  };
}

/** How the pod's agentd container ended, from its current or last terminated state. */
export function podExit(pod: PodLike | null): SandboxExit | undefined {
  const container = pod?.status?.containerStatuses?.find((status) => status.name === AGENT_CONTAINER);
  const terminated = container?.state?.terminated ?? container?.lastState?.terminated;
  if (!terminated?.reason) return undefined;
  return {
    reason: terminated.reason,
    ...(typeof terminated.exitCode === "number" ? { exitCode: terminated.exitCode } : {}),
    ...(terminated.finishedAt ? { finishedAt: terminated.finishedAt } : {}),
  };
}

function claimName(runId: string): string {
  return `run-${runId}`;
}

// ---------- wire shapes (only the fields this provider reads/writes) ----------

interface SandboxClaimEnvVar {
  name: string;
  value: string;
  containerName?: string;
}

interface SandboxClaimLifecycle {
  shutdownPolicy?: "Delete" | "DeleteForeground" | "Retain";
  shutdownTime?: string;
  ttlSecondsAfterFinished?: number;
}

interface SandboxClaimSpec {
  warmPoolRef: { name: string };
  env?: SandboxClaimEnvVar[];
  additionalPodMetadata?: { annotations?: Record<string, string>; labels?: Record<string, string> };
  lifecycle?: SandboxClaimLifecycle;
}

interface Condition {
  type?: string;
  status?: string;
  reason?: string;
}

/** Both SandboxClaim.status and Sandbox.status carry `.conditions` (§4.3's Sandbox fallback GET
 * reads the same shape), so condition() below accepts either. */
interface ConditionsHolder {
  status?: { conditions?: Condition[] };
}

interface SandboxClaim extends ConditionsHolder {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace: string;
    labels?: Record<string, string>;
    deletionTimestamp?: string;
    /** M4: the start deadline is measured from here. */
    creationTimestamp?: string;
  };
  spec: SandboxClaimSpec;
  status?: { conditions?: Condition[]; sandbox?: { name?: string } };
}

interface SandboxWarmPool {
  spec: { replicas: number; sandboxTemplateRef?: { name: string } };
  status?: { readyReplicas?: number };
}

interface KubeList<T> {
  items?: T[];
}

function condition(holder: ConditionsHolder | null | undefined, type: string): Condition | undefined {
  return holder?.status?.conditions?.find((c) => c.type === type);
}

/** Status derived from the claim alone (§4.3's rows that don't need the Sandbox fallback GET).
 * Returns "starting" for the ambiguous "Ready=False, some other reason" and "no status.sandbox.name
 * yet" rows -- status() resolves that ambiguity with one extra GET when it matters; capacity()
 * deliberately doesn't (an extra per-claim GET would defeat the point of one LIST call), so it
 * counts an ambiguous claim as active, which only ever overcounts, never undercounts. */
function claimPhase(claim: SandboxClaim): SandboxStatus {
  if (claim.metadata.deletionTimestamp) return "exited";
  const ready = condition(claim, "Ready");
  if (ready?.status === "True") return "running";
  if (ready?.status === "False" && ready.reason && EXITED_READY_REASONS.has(ready.reason)) return "exited";
  return "starting";
}

/** Thrown by the real transport with the Kubernetes API's HTTP status attached, so callers can
 * distinguish 404 (not found), 409 (conflict/already exists) and everything else without parsing
 * message text. */
export class KubeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "KubeError";
    this.status = status;
  }
}

/** The subset of a Kubernetes `Status` error body (see errorFor's doc comment) this provider
 * trusts: `code` and `reason` only, both machine-set by the API server itself, never `message` or
 * `details` (which can echo request content back). */
interface K8sStatus {
  code?: number;
  reason?: string;
}

function isK8sStatus(json: unknown): json is K8sStatus {
  if (typeof json !== "object" || json === null) return false;
  const obj = json as Record<string, unknown>;
  return (obj.code === undefined || typeof obj.code === "number") && (obj.reason === undefined || typeof obj.reason === "string");
}

/** Curated, fixed hints per Kubernetes `Status.reason` -- never derived from server-provided text. */
const REASON_HINTS: Record<string, string> = {
  Unauthorized: "the request was not authenticated",
  Forbidden: "the api's service account may not perform this action",
  NotFound: "not found",
  AlreadyExists: "already exists",
  Conflict: "already exists or is being modified",
  Invalid: "the request was rejected by admission",
  BadRequest: "the request was malformed",
  Timeout: "the server timed out the request",
  TooManyRequests: "rate limited",
  InternalError: "the cluster returned an internal error",
};

/** Review finding L6: thrown only by endpoint discovery (resolveGkeEndpoint) and the auth-client
 * build it's part of -- a wrong cluster/location/project, or clusters.get itself failing, is a
 * different failure than "the warm pool object is missing" or "the claim doesn't exist", even
 * though both can surface as a 404. Callers (routes/hooks.ts) check for this type first so a
 * misconfigured GKE_CLUSTER doesn't get reported to a caller as "warm pool not found". */
export class GkeEndpointError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GkeEndpointError";
  }
}

/** Review finding M2: a failed start() must never let the run's own token reach an error message
 * that ends up as `Run.reason`/`statusDetail` (both user-visible) or, worse, a hook's HTTP
 * response. Kubernetes admission can echo the request body back in a 422, and the claim body
 * carries RUN_TOKEN in claim env (cold mode) -- so redact defensively rather than trusting the
 * server side (errorFor below) alone to never include it. */
function redactToken(message: string, token: string): string {
  if (!token) return message;
  return message.split(token).join("«redacted»");
}

/** Rewraps `err` with its message redacted, preserving KubeError's status (so callers that switch
 * on `err.status` after a rethrow -- there are none today, but the type itself promises it -- keep
 * working) and the original as `cause` for local debugging (never serialized to the run record or
 * an HTTP response). */
function redactErrorToken(err: unknown, token: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const redacted = redactToken(message, token);
  if (err instanceof KubeError) return new KubeError(err.status, redacted);
  return new Error(redacted, { cause: err });
}

/** Thin REST seam over the subset of the Kubernetes API this provider needs (mirrors cloudrun.ts's
 * JobsClientLike/ExecutionsClientLike -- an interface small enough to stub in tests with no
 * credentials and no network). */
export interface KubeClientLike {
  /** null on 404. */
  get<T>(path: string): Promise<T | null>;
  /** Throws KubeError; a 409 (already exists) is surfaced, not swallowed, so start() can decide
   * how to treat it. */
  create<T>(path: string, body: unknown): Promise<T>;
  /** Background propagation. A 404 is treated as success (already gone). */
  delete(path: string): Promise<void>;
  list<T>(path: string, labelSelector?: string): Promise<T[]>;
  /** application/merge-patch+json. */
  patch(path: string, body: unknown): Promise<void>;
}

export interface GkeProviderConfig {
  project: string;
  location: string;
  cluster: string;
  namespace: string;
  warmPool: string;
  /** GKE_ENDPOINT override; empty resolves the DNS endpoint from the clusters.get API. */
  endpoint?: string;
  launchMode: GkeLaunchMode;
  /** GKE_MAX_ACTIVE. Review finding L1: this is a *soft* cap under concurrent starts -- start()
   * reads the active count, then creates a claim as two separate calls with no lock between them,
   * so N wakes racing the same instant can all pass the check before any of their claims exist and
   * together land a little over maxActive. Fine for its purpose (a cost guardrail, spec §5.3), not
   * a hard admission-control limit. */
  maxActive: number;
}

export interface GkeProviderDeps {
  /** Test-injectable transport factory; production builds the real HTTP client lazily on first use. */
  kube?: () => Promise<KubeClientLike>;
  now?: () => Date;
}

function isConflict(err: unknown): boolean {
  if (err instanceof KubeError) return err.status === 409;
  return false;
}

export class GkeProvider implements SandboxProvider {
  private readonly config: GkeProviderConfig;
  private readonly deps: Required<GkeProviderDeps>;
  private kubeClientPromise: Promise<KubeClientLike> | undefined;

  constructor(config: GkeProviderConfig, deps: GkeProviderDeps = {}) {
    this.config = config;
    this.deps = {
      kube: deps.kube ?? (() => this.buildKubeClient()),
      now: deps.now ?? (() => new Date()),
    };
  }

  /** Review finding M1: a *rejected* promise must not stay memoized -- `??=` alone would cache a
   * transient failure (one metadata hiccup, one clusters.get 5xx) for the rest of the process's
   * life, breaking every gke call on this instance until it's recycled. Clearing the memo on
   * rejection lets the next call retry the build from scratch. */
  private kube(): Promise<KubeClientLike> {
    if (!this.kubeClientPromise) {
      this.kubeClientPromise = this.deps.kube().catch((err: unknown) => {
        this.kubeClientPromise = undefined;
        throw err;
      });
    }
    return this.kubeClientPromise;
  }

  private async buildKubeClient(): Promise<KubeClientLike> {
    const { GoogleAuth } = await import("google-auth-library");
    const auth = new GoogleAuth({ scopes: [...GKE_TOKEN_SCOPES] });
    const authClient = await auth.getClient();
    const getToken = async () => {
      const token = await authClient.getAccessToken();
      if (!token.token) throw new Error("gke: google-auth-library returned no access token");
      return token.token;
    };
    const endpoint = this.config.endpoint || (await resolveGkeEndpoint(this.config, getToken));
    return new HttpKubeClient(endpoint, getToken);
  }

  private buildClaim(run: RunLaunch): SandboxClaim {
    const name = claimName(run.runId);
    const shutdownTime = new Date(this.deps.now().getTime() + CLAIM_SHUTDOWN_AFTER_MS).toISOString();
    const spec: SandboxClaimSpec = {
      warmPoolRef: { name: this.config.warmPool },
      lifecycle: {
        shutdownPolicy: "Delete",
        shutdownTime,
        ttlSecondsAfterFinished: CLAIM_TTL_SECONDS_AFTER_FINISHED,
      },
    };
    if (this.config.launchMode === "warm") {
      // Warm mode (spec §3.5 Option B): no claim env (that would force a cold start) -- the run's
      // identity goes on the pod as annotations instead, which the controller patches onto an
      // already-running warm pod's metadata.
      spec.additionalPodMetadata = {
        annotations: {
          [ANNOTATION_RUN_ID]: run.runId,
          [ANNOTATION_RUN_TOKEN]: run.runToken,
          [ANNOTATION_API]: run.apiOrigin,
        },
      };
    } else {
      // Cold mode (default): claim env. This always forces a cold start (sandboxclaim_types.go's
      // Env doc comment; envVarsInjectionPolicy: Allowed on the template) -- fine, that's the point.
      spec.env = [
        { name: ENV_RUN_ID, value: run.runId },
        { name: ENV_RUN_TOKEN, value: run.runToken },
        { name: ENV_API, value: run.apiOrigin },
      ];
    }
    return {
      apiVersion: EXTENSIONS_API,
      kind: "SandboxClaim",
      metadata: {
        name,
        namespace: this.config.namespace,
        labels: { [MANAGED_BY_LABEL]: MANAGED_BY_VALUE, [RUN_ID_LABEL]: run.runId },
      },
      spec,
    };
  }

  async start(run: RunLaunch): Promise<SandboxStartResult> {
    const kube = await this.kube();
    // L1: countActive() alone, not the full capacity() (which also GETs the warm pool -- a read
    // start() has no use for).
    const active = await this.countActive(kube);
    if (active >= this.config.maxActive) {
      throw new Error(`gke: max active sandboxes (${this.config.maxActive}) reached`);
    }

    const namespace = this.config.namespace;
    const name = claimName(run.runId);
    const claim = this.buildClaim(run);
    // Handle format gke:<namespace>/<claim-name>, per docs/reports/gke-spike.md's s2_wake.ts
    // prototype -- opaque to every caller but this provider (spec §4.2); the run token never
    // appears in it (C8).
    const handle = `gke:${namespace}/${name}`;

    try {
      await kube.create(claimsPath(namespace), claim);
    } catch (err) {
      if (isConflict(err)) {
        // Same name already exists: idempotent retry (e.g. a wake that raced a retry). If the
        // claim is actually there and not on its way out, treat this as success; a claim already
        // terminating (L5) can't be adopted, so that's a real failure, not idempotency.
        const existing = await kube.get<SandboxClaim>(claimPath(namespace, name));
        if (existing && !existing.metadata.deletionTimestamp) return { handle };
        if (existing) {
          throw new Error(`gke: claim ${name} already exists and is terminating`);
        }
      }
      // M2: never let the run's own token reach an error message that becomes Run.reason/
      // statusDetail (both user-visible) -- admission can echo the request body (which carries
      // RUN_TOKEN in claim env) back in a 4xx.
      throw redactErrorToken(err, run.runToken);
    }

    if (this.config.launchMode === "cold") {
      // Claim env always forces a cold start -- we know this deterministically, no GET needed.
      return { handle, warm: false };
    }

    // Warm mode: one best-effort GET right after create (spec §4.2). If the claim already adopted
    // a warm pod (status.sandbox.name set and Ready), report warm: true; otherwise we can't tell
    // yet (a cold fallback pod takes longer than this one GET to become Ready) -- undefined.
    try {
      const created = await kube.get<SandboxClaim>(claimPath(namespace, name));
      const ready = condition(created, "Ready");
      const warm = Boolean(created?.status?.sandbox?.name) && ready?.status === "True" ? true : undefined;
      return { handle, warm };
    } catch {
      return { handle };
    }
  }

  /** L1: split out of capacity() so start()'s pre-flight check doesn't also GET the warm pool. */
  private async countActive(kube: KubeClientLike): Promise<number> {
    const claims = await kube.list<SandboxClaim>(claimsPath(this.config.namespace), `${MANAGED_BY_LABEL}=${MANAGED_BY_VALUE}`);
    return claims.filter((claim) => claimPhase(claim) !== "exited").length;
  }

  async stop(handle: SandboxHandle): Promise<void> {
    if (!handle) return;
    const parsed = parseHandle(handle);
    if (!parsed) return;
    const kube = await this.kube();
    try {
      await kube.delete(claimPath(parsed.namespace, parsed.name));
    } catch (err) {
      // KubeClientLike's own contract already treats 404 as success (delete()'s doc comment); this
      // is a defensive second line, in case a transport throws instead -- "already gone" either
      // way, not a real failure. C4 (stop is idempotent).
      if (err instanceof KubeError && err.status === 404) return;
      throw err;
    }
  }

  async status(handle: SandboxHandle): Promise<SandboxStatus> {
    if (!handle) return "unknown";
    const parsed = parseHandle(handle);
    if (!parsed) return "unknown";
    const kube = await this.kube();
    const claim = await kube.get<SandboxClaim>(claimPath(parsed.namespace, parsed.name));
    if (!claim) return "exited";

    const phase = claimPhase(claim);
    if (phase !== "starting") return phase;

    // Ambiguous per the claim alone: §4.3's Sandbox Finished fallback, only reachable via the
    // Role's `get` on sandboxes (no list, no pods) -- exactly the RBAC this provider is scoped to.
    const sandboxName = claim.status?.sandbox?.name;
    if (sandboxName) {
      const sandbox = await kube.get<ConditionsHolder>(sandboxPath(parsed.namespace, sandboxName));
      const finished = condition(sandbox, "Finished");
      if (finished?.status === "True") return "exited";
    }

    // M4: still ambiguous, but a claim can also sit here forever (ImagePullBackOff, unschedulable,
    // AdoptionConflict...). Past START_DEADLINE_MS since creation, stop calling it "starting" --
    // the reconciler skips that state outright, so a stuck claim would otherwise hold a
    // GKE_MAX_ACTIVE slot and block the session's wakes until the claim's 24h shutdownTime.
    // "unknown" falls through to the reconciler's stop-then-fail path, same as a status() error.
    if (isPastStartDeadline(claim, this.deps.now())) return "unknown";
    return "starting";
  }

  /** #193: the claimed pod's agentd termination state (OOMKilled, Error with an exit code, ...).
   * Claim -> Sandbox -> pod, the same lookup agent-sandbox itself does. Undefined while agentd is
   * running, once the claim or pod is gone (the controller deletes a finished claim ~2 min later),
   * or while the Role still lacks `pods: get` (a 403 until the owner runs gke-iam.sh). */
  async exitInfo(handle: SandboxHandle): Promise<SandboxExit | undefined> {
    return podExit(await this.claimedPod(handle));
  }

  /** #197: the claimed pod's details for the session page (podInfo's whitelist only). */
  async describe(handle: SandboxHandle): Promise<SandboxInfo | undefined> {
    return podInfo(await this.claimedPod(handle));
  }

  /** The pod behind a claim handle: claim -> Sandbox -> pod, agent-sandbox's own resolvePodName.
   * Null when any step is gone, or while the Role lacks `pods: get` (a 403, logged once). */
  private async claimedPod(handle: SandboxHandle): Promise<PodLike | null> {
    const parsed = handle ? parseHandle(handle) : undefined;
    if (!parsed) return null;
    const kube = await this.kube();
    try {
      const claim = await kube.get<SandboxClaim>(claimPath(parsed.namespace, parsed.name));
      const sandboxName = claim?.status?.sandbox?.name;
      if (!sandboxName) return null;
      const sandbox = await kube.get<{ metadata?: { annotations?: Record<string, string> } }>(
        sandboxPath(parsed.namespace, sandboxName),
      );
      if (!sandbox) return null;
      const podName = sandbox.metadata?.annotations?.[SANDBOX_POD_NAME_ANNOTATION] || sandboxName;
      return await kube.get<PodLike>(podPath(parsed.namespace, podName));
    } catch (err) {
      if (err instanceof KubeError && err.status === 403) {
        if (!this.warnedPodsForbidden) {
          this.warnedPodsForbidden = true;
          console.warn("[gke] pods: get is not granted yet (run deploy/gke-iam.sh); sandbox exit reasons stay unknown");
        }
        return null;
      }
      throw err;
    }
  }

  private warnedPodsForbidden = false;

  /** The providers dashboard's probe (#169). The kube client (and so the resolved endpoint) is
   * memoized by kube(), and google-auth-library caches the access token until it nears expiry, so
   * only an instance's first call pays for those; the two reads below run in parallel. */
  async capacity(): Promise<SandboxCapacity> {
    const kube = await this.kube();
    const [active, pool] = await Promise.all([
      this.countActive(kube),
      kube.get<SandboxWarmPool>(warmPoolPath(this.config.namespace, this.config.warmPool)),
    ]);
    return {
      active,
      warmReady: pool?.status?.readyReplicas,
      warmDesired: pool?.spec?.replicas,
      limit: this.config.maxActive,
      launchMode: this.config.launchMode,
    };
  }

  /** §5.3 guardrail 1: the scheduled warm-pool hook (routes/hooks.ts's POST /api/hooks/warm-pool)
   * patches spec.replicas via the RBAC Role's `patch` on sandboxwarmpools -- the only write this
   * provider makes outside a run's own start/stop. */
  async setWarmPoolReplicas(replicas: number): Promise<void> {
    const kube = await this.kube();
    await kube.patch(warmPoolPath(this.config.namespace, this.config.warmPool), { spec: { replicas } });
  }
}

function parseHandle(handle: SandboxHandle): { namespace: string; name: string } | undefined {
  const match = /^gke:([^/]+)\/(.+)$/.exec(handle);
  if (!match) return undefined;
  return { namespace: match[1], name: match[2] };
}

/** M4: true once `claim` has been ambiguously "starting" longer than START_DEADLINE_MS. A missing
 * or unparseable creationTimestamp never forces "unknown" -- there's no evidence for it, and
 * status() should err toward "starting" (which the reconciler already treats as provisioning)
 * rather than fail a run early on a field the fake/real API happened not to set. */
function isPastStartDeadline(claim: SandboxClaim, now: Date): boolean {
  const created = claim.metadata.creationTimestamp;
  if (!created) return false;
  const createdMs = Date.parse(created);
  if (!Number.isFinite(createdMs)) return false;
  return now.getTime() - createdMs > START_DEADLINE_MS;
}

/** §4.1 endpoint discovery: one GET of clusters.get, reading
 * controlPlaneEndpointsConfig.dnsEndpointConfig.endpoint (memoized by the caller -- buildKubeClient
 * runs this at most once per provider instance, since the registry itself memoizes providers per
 * process). Exported (and taking a plain `getToken` rather than an AuthClient) so it's testable
 * with a stubbed token and a stubbed global fetch, with no google-auth-library or network
 * involved -- only `GkeProviderConfig.endpoint` being unset reaches this at all. */
export async function resolveGkeEndpoint(
  config: Pick<GkeProviderConfig, "project" | "location" | "cluster">,
  getToken: () => Promise<string>,
): Promise<string> {
  const token = await getToken();
  const url = `https://container.googleapis.com/v1/projects/${config.project}/locations/${config.location}/clusters/${config.cluster}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw new GkeEndpointError(describeFetchFailure(err, `clusters.get for ${config.cluster}`), { cause: err });
  }
  // L6: a distinct error type from KubeError -- a wrong cluster/location/project (or clusters.get
  // itself failing) is a different failure than "the warm pool is missing" or "the claim doesn't
  // exist", even though both can be a 404. Callers that only check `KubeError.status === 404`
  // (routes/hooks.ts) must not mistake this one for that.
  if (!res.ok) {
    throw new GkeEndpointError(`gke: clusters.get for ${config.cluster} failed: HTTP ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as {
    controlPlaneEndpointsConfig?: { dnsEndpointConfig?: { endpoint?: string } };
  };
  const dnsEndpoint = body.controlPlaneEndpointsConfig?.dnsEndpointConfig?.endpoint;
  if (!dnsEndpoint) {
    throw new GkeEndpointError(
      `gke: cluster ${config.cluster} has no controlPlaneEndpointsConfig.dnsEndpointConfig.endpoint ` +
        "(enable-dns-access?)",
    );
  }
  return dnsEndpoint;
}

/** L2: `fetch` rejects (rather than resolving with a non-ok Response) on a network failure or an
 * `AbortSignal.timeout()` firing -- undici surfaces the latter as a DOMException/Error named
 * "TimeoutError". Give both a clean, bounded message instead of letting a raw fetch/undici error
 * (which can be a wall of cause-chain text) become a run's statusDetail or a hook's response. */
function describeFetchFailure(err: unknown, what: string): string {
  const name = err instanceof Error ? err.name : undefined;
  if (name === "TimeoutError" || name === "AbortError") {
    return `gke: ${what} timed out after ${FETCH_TIMEOUT_MS}ms`;
  }
  return `gke: ${what} failed: network error`;
}

/** Real transport: Google OAuth access token (from GoogleAuth, GKE_TOKEN_SCOPES) plus plain
 * `fetch` against the cluster's DNS endpoint (spec §4.1: publicly trusted certificate, no CA
 * handling needed -- confirmed by spike S6). `getToken` is called per request rather than cached
 * here, since google-auth-library's AuthClient.getAccessToken() already caches/refreshes and this
 * keeps HttpKubeClient itself stateless about auth. Exported so a test can verify the exact
 * request shape (method, path, headers, merge-patch content type) against a stubbed global fetch,
 * with no credentials and no network. */
export class HttpKubeClient implements KubeClientLike {
  private readonly endpoint: string;
  private readonly getToken: () => Promise<string>;

  // Plain fields, not TS constructor-parameter properties: see registry.ts's SandboxProviders
  // comment -- those aren't erasable syntax, so `node --test` (type-stripping, no build step)
  // can't load a class that uses them.
  constructor(endpoint: string, getToken: () => Promise<string>) {
    this.endpoint = endpoint;
    this.getToken = getToken;
  }

  private async request(method: string, path: string, body?: unknown, contentType = "application/json"): Promise<Response> {
    const token = await this.getToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers["Content-Type"] = contentType;
    try {
      return await fetch(`https://${this.endpoint}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        // L2: bounded, so a hung cluster/metadata server can't wedge a wake or a reconcile tick.
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      // L2: a clean, bounded message instead of a raw fetch/undici error (which can include a long
      // cause chain) reaching Run.reason/statusDetail or a hook's response.
      throw new KubeError(0, describeFetchFailure(err, `${method} ${path}`));
    }
  }

  /** M2: never let a Kubernetes error response's raw body reach a caller. Admission can echo the
   * request back in a 4xx (a claim's `spec.env` carries RUN_TOKEN in cold mode), and even without
   * that, the body is arbitrary server text that ends up as Run.reason/statusDetail (both
   * user-visible) or a hook's HTTP response. Kubernetes error bodies are a `Status` object
   * (`{status, message, reason, code}`, https://kubernetes.io/docs/reference/using-api/api-concepts/#error-codes-and-messages);
   * this keeps only `code` and the short, machine-set `reason` (e.g. "Forbidden", "Conflict") --
   * never `message` or `details`, which are exactly the fields a server could echo request content
   * into -- plus a fixed, curated hint per reason. Falls back to the plain HTTP status/statusText
   * when the body isn't a Status object (or isn't JSON at all). */
  private async errorFor(res: Response): Promise<KubeError> {
    const parsed = await res
      .json()
      .then((json) => (isK8sStatus(json) ? json : undefined))
      .catch(() => undefined);
    const code = parsed?.code ?? res.status;
    const reason = parsed?.reason || res.statusText || String(res.status);
    const hint = REASON_HINTS[reason];
    const message = hint ? `gke: ${code} ${reason} (${hint})` : `gke: ${code} ${reason}`;
    return new KubeError(res.status, message);
  }

  async get<T>(path: string): Promise<T | null> {
    const res = await this.request("GET", path);
    if (res.status === 404) return null;
    if (!res.ok) throw await this.errorFor(res);
    return (await res.json()) as T;
  }

  async create<T>(path: string, body: unknown): Promise<T> {
    const res = await this.request("POST", path, body);
    if (!res.ok) throw await this.errorFor(res);
    return (await res.json()) as T;
  }

  async delete(path: string): Promise<void> {
    const res = await this.request("DELETE", path, { propagationPolicy: "Background" });
    if (res.status === 404) return;
    if (!res.ok) throw await this.errorFor(res);
  }

  async list<T>(path: string, labelSelector?: string): Promise<T[]> {
    const query = labelSelector ? `?labelSelector=${encodeURIComponent(labelSelector)}` : "";
    const res = await this.request("GET", `${path}${query}`);
    if (!res.ok) throw await this.errorFor(res);
    const body = (await res.json()) as KubeList<T>;
    return body.items ?? [];
  }

  async patch(path: string, body: unknown): Promise<void> {
    const res = await this.request("PATCH", path, body, "application/merge-patch+json");
    if (!res.ok) throw await this.errorFor(res);
  }
}
