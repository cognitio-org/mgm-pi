#!/usr/bin/env python3
"""Spike S1: claim-create -> value visible in the warm pod's downward-API file, N times.

Needs s1.yaml applied. Each round waits for an unclaimed warm pod (its probe has logged
"run-id=[]"), creates a SandboxClaim whose additionalPodMetadata sets the annotation, and finds
the probe's "run-id=[<value>]" log line. Latency = that line's kubelet timestamp minus the
laptop's clock just before `kubectl create` (so it includes kubectl's own round trip, and any
laptop/node clock skew, typically tens of ms under NTP). A round whose value turns up in a
pod that wasn't the warm one is reported as cold.

    python3 s1_measure.py [rounds]    # default 20; prints one JSON line per round, then a summary
"""
import json
import os
import statistics
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone

NS = "outfitter-spike"
KUBECONFIG = os.path.expanduser("~/.kube/outfitter")
ENV = dict(os.environ, CLOUDSDK_ACTIVE_CONFIG_NAME="outfitter")


def kc(*args, stdin=None, check=True):
    r = subprocess.run(["kubectl", f"--kubeconfig={KUBECONFIG}", "-n", NS, *args],
                       input=stdin, capture_output=True, text=True, env=ENV)
    if check and r.returncode != 0:
        raise RuntimeError(f"kubectl {' '.join(args)}: {r.stderr.strip()}")
    return r.stdout


def parse_ts(ts):
    # RFC3339 with nanoseconds -> microseconds, which fromisoformat accepts.
    head, frac = ts.rstrip("Z").split(".")
    return datetime.fromisoformat(f"{head}.{frac[:6]}").replace(tzinfo=timezone.utc).timestamp()


def probe_lines(pod):
    out = kc("logs", "--timestamps", pod, check=False)
    lines = []
    for line in out.splitlines():
        ts, _, msg = line.partition(" ")
        if msg.startswith("run-id="):
            lines.append((parse_ts(ts), msg))
    return lines


def warm_ready_pod():
    """An unclaimed warm pod whose probe is already polling, or None."""
    sandboxes = json.loads(kc("get", "sandboxes", "-o", "json"))["items"]
    for sb in sandboxes:
        owners = sb["metadata"].get("ownerReferences", [])
        if not any(o["kind"] == "SandboxWarmPool" for o in owners):
            continue
        pod = sb["metadata"]["name"]
        if any(msg == "run-id=[]" for _, msg in probe_lines(pod)):
            return pod
    return None


def wait_warm(timeout):
    start = time.time()
    while time.time() - start < timeout:
        pod = warm_ready_pod()
        if pod:
            return pod, time.time() - start
        time.sleep(1)
    raise TimeoutError(f"no warm pod ready within {timeout}s")


CLAIM = """apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxClaim
metadata: {{ name: {name}, namespace: {ns} }}
spec:
  warmPoolRef: {{ name: s1-probe }}
  additionalPodMetadata:
    annotations: {{ outfitter.dev/run-id: "{value}" }}
  lifecycle: {{ shutdownPolicy: Delete }}
"""


def one_round(i):
    warm, waited = wait_warm(600 if i == 1 else 180)
    value = f"r{i}-{uuid.uuid4().hex[:8]}"
    name = f"s1-claim-{i}-{uuid.uuid4().hex[:4]}"
    t0 = time.time()
    kc("create", "-f", "-", stdin=CLAIM.format(name=name, ns=NS, value=value))
    create_s = time.time() - t0  # kubectl's round trip (auth plugin, DNS endpoint, admission)
    target = f"run-id=[{value}]"
    deadline = t0 + 120
    result = None
    while time.time() < deadline and result is None:
        for pod in kc("get", "pods", "-l", "app=s1-probe", "-o", "name").split():
            pod = pod.split("/", 1)[1]
            for ts, msg in probe_lines(pod):
                if msg == target:
                    result = {"round": i, "latency_s": round(ts - t0, 3),
                              "create_s": round(create_s, 3),
                              "mode": "warm" if pod == warm else "cold", "pod": pod,
                              "waited_for_warm_s": round(waited, 1)}
                    break
            if result:
                break
        time.sleep(0.2)
    kc("delete", "sandboxclaim", name, "--wait=false", check=False)
    return result or {"round": i, "latency_s": None, "mode": "timeout", "warm_pod": warm}


def main():
    rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    results = []
    for i in range(1, rounds + 1):
        r = one_round(i)
        results.append(r)
        print(json.dumps(r), flush=True)
    warm = sorted(r["latency_s"] for r in results if r["mode"] == "warm")
    summary = {"rounds": rounds, "warm": len(warm),
               "cold": sum(r["mode"] == "cold" for r in results),
               "timeouts": sum(r["mode"] == "timeout" for r in results)}
    if warm:
        summary.update(p50_s=statistics.median(warm),
                       p90_s=warm[max(0, int(round(0.9 * len(warm))) - 1)],
                       min_s=warm[0], max_s=warm[-1])
    print(json.dumps({"summary": summary}), flush=True)


if __name__ == "__main__":
    main()
