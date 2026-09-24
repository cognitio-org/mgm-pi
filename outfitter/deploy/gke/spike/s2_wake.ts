// Spike S2 (docs/reports/gke-spike.md): wake one production session onto GKE, once.
//
// Runs the api's own RunManager.wake() against the production store, so the run record, its
// runTokenHash and insertIfNoActive behave exactly as a real wake. The only difference is the
// provider: a throwaway one whose start() creates a cold SandboxClaim on the s2-agent pool (s2.yaml)
// carrying RUN_ID/RUN_TOKEN/OUTFITTER_API as claim env. Nothing else of the api starts: no server,
// no reconciler, no mailbox. The run token goes to kubectl on stdin and is never printed.
//
// The deployed link then treats the run like any other. The production reconciler leaves it alone
// while it heartbeats; a stop from the UI reaches agentd over the socket (graceful stop), and
// production's own Cloud Run stop() on the "gke:" handle fails harmlessly (runs.ts catches it).
//
//   MONGODB_URI=... node deploy/gke/spike/s2_wake.ts <session-id>     (from outfitter/)
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import type { RunLaunch, SandboxProvider, SandboxStatus } from "@outfitter/provider-local";
import { loadConfig } from "../../../packages/api/src/config.ts";
import { openStore } from "../../../packages/api/src/store/index.ts";
import { RunManager } from "../../../packages/api/src/runs.ts";

const LINK_ORIGIN = "https://link.kernal.one";
const NS = "outfitter-sandboxes";

const sessionId = process.argv[2];
if (!sessionId) throw new Error("usage: node s2_wake.ts <session-id>");

const config = loadConfig({ ...process.env, OUTFITTER_ORIGIN: LINK_ORIGIN });
if (config.mongodbUri === "memory") throw new Error("MONGODB_URI is unset: this spike wakes a production session");

const kubectl = (args: string[], input?: string) =>
  execFileSync("kubectl", [`--kubeconfig=${homedir()}/.kube/outfitter`, "-n", NS, ...args], {
    input,
    env: { ...process.env, CLOUDSDK_ACTIVE_CONFIG_NAME: "outfitter" },
    encoding: "utf8",
  });

let claimName: string | undefined;
const spikeProvider: SandboxProvider = {
  async start(run: RunLaunch) {
    claimName = `s2-${run.runId.slice(0, 8)}`;
    const claim = {
      apiVersion: "extensions.agents.x-k8s.io/v1beta1",
      kind: "SandboxClaim",
      metadata: { name: claimName, namespace: NS, labels: { "outfitter.dev/run-id": run.runId } },
      spec: {
        warmPoolRef: { name: "s2-agent" },
        env: [
          { name: "RUN_ID", value: run.runId },
          { name: "RUN_TOKEN", value: run.runToken },
          { name: "OUTFITTER_API", value: LINK_ORIGIN },
        ],
        lifecycle: { shutdownPolicy: "Delete" },
      },
    };
    kubectl(["create", "-f", "-"], JSON.stringify(claim));
    return { handle: `gke:${NS}/${claimName}` };
  },
  async stop() {},
  async status(): Promise<SandboxStatus> {
    return "unknown";
  },
};

const store = await openStore(config.mongodbUri, config.mongodbDb);
try {
  const started = Date.now();
  const run = await new RunManager(store, spikeProvider, config).wake(sessionId);
  if (!claimName) {
    console.log(JSON.stringify({ note: "session already had an active run; nothing created", runId: run.id, state: run.state }));
  } else {
    console.log(JSON.stringify({
      runId: run.id, state: run.state, handle: run.providerHandle, claim: claimName,
      wokeAt: new Date(started).toISOString(), wakeMs: Date.now() - started,
    }));
  }
} finally {
  await store.close();
}
