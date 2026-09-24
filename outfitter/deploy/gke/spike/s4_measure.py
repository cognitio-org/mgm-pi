#!/usr/bin/env python3
"""Spike S4: cold claims of the real image; claim-create -> scheduled / pulled / started / first log.

Needs s4.yaml applied (pool replicas 0, so every claim is cold). Per round: create a claim, wait
for its pod to finish (agentd exits with no run), read the pod's conditions, events and first
log line, delete the claim. Times are from the laptop clock just before `kubectl create`; pod
conditions and container start times are whole seconds, the log timestamp and the kubelet's
"pulled in" figure are precise.

    python3 s4_measure.py [rounds]   # default 10; one JSON line per round, then a summary
"""
import json
import os
import re
import statistics
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone

NS = "outfitter-sandboxes"
ENV = dict(os.environ, CLOUDSDK_ACTIVE_CONFIG_NAME="outfitter")
BASE = ["kubectl", f"--kubeconfig={os.path.expanduser('~/.kube/outfitter')}", "-n", NS]


def kc(*args, stdin=None, check=True):
    r = subprocess.run(BASE + list(args), input=stdin, capture_output=True, text=True, env=ENV)
    if check and r.returncode != 0:
        raise RuntimeError(f"kubectl {' '.join(args)}: {r.stderr.strip()}")
    return r.stdout


def ts(s):
    if not s:
        return None
    s = s.rstrip("Z")
    if "." in s:
        head, frac = s.split(".")
        s = f"{head}.{frac[:6]}"
    return datetime.fromisoformat(s).replace(tzinfo=timezone.utc).timestamp()


CLAIM = """apiVersion: extensions.agents.x-k8s.io/v1beta1
kind: SandboxClaim
metadata: {{ name: {name}, namespace: {ns} }}
spec:
  warmPoolRef: {{ name: s4-coldstart }}
  lifecycle: {{ shutdownPolicy: Delete }}
"""


def one_round(i):
    name = f"s4-claim-{i}-{uuid.uuid4().hex[:4]}"
    t0 = time.time()
    kc("create", "-f", "-", stdin=CLAIM.format(name=name, ns=NS))
    pod = None
    deadline = t0 + 400
    while time.time() < deadline:
        items = json.loads(kc("get", "pods", "-l", "app=s4-coldstart", "-o", "json"))["items"]
        fresh = [p for p in items if ts(p["metadata"]["creationTimestamp"]) >= int(t0) - 1]
        if fresh:
            pod = fresh[0]
            if pod["status"].get("phase") in ("Succeeded", "Failed"):
                break
            cs = pod["status"].get("containerStatuses") or []
            if cs and "terminated" in cs[0].get("state", {}):
                break
        time.sleep(2)
    if pod is None:
        kc("delete", "sandboxclaim", name, "--wait=false", check=False)
        return {"round": i, "error": "no pod"}
    podname = pod["metadata"]["name"]
    pod = json.loads(kc("get", "pod", podname, "-o", "json"))
    conds = {c["type"]: ts(c.get("lastTransitionTime")) for c in pod["status"].get("conditions", [])}
    cs = (pod["status"].get("containerStatuses") or [{}])[0]
    state = cs.get("state", {})
    started = ts((state.get("running") or state.get("terminated") or {}).get("startedAt"))
    events = json.loads(kc("get", "events", "--field-selector", f"involvedObject.name={podname}",
                           "-o", "json"))["items"]
    pull = next((e["message"] for e in events if e.get("reason") in ("Pulled",)), None)
    pulled_in = None
    if pull:
        m = re.search(r"in ([\d.]+)(ms|s) \(", pull)
        if m:
            pulled_in = float(m.group(1)) / (1000 if m.group(2) == "ms" else 1)
    scaleup = any(e.get("reason") == "TriggeredScaleUp" for e in events)
    logs = kc("logs", "--timestamps", podname, check=False).splitlines()
    first_log = ts(logs[0].split(" ", 1)[0]) if logs else None
    kc("delete", "sandboxclaim", name, "--wait=false", check=False)
    rel = lambda t: round(t - t0, 1) if t else None
    return {"round": i, "node": pod["spec"].get("nodeName"), "new_node": scaleup,
            "image_cached": bool(pull and "already present" in pull),
            "scheduled_s": rel(conds.get("PodScheduled")), "pulled_in_s": pulled_in,
            "started_s": rel(started), "first_log_s": rel(first_log),
            "exit": (state.get("terminated") or {}).get("exitCode"),
            "first_log": logs[0].split(" ", 1)[1][:160] if logs else None}


def main():
    rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    results = []
    for i in range(1, rounds + 1):
        r = one_round(i)
        results.append(r)
        print(json.dumps(r), flush=True)
        time.sleep(3)
    ok = [r for r in results if r.get("started_s") is not None]
    started = sorted(r["started_s"] for r in ok)
    summary = {"rounds": rounds, "with_start": len(ok),
               "new_node_rounds": sum(bool(r.get("new_node")) for r in ok)}
    if started:
        summary.update(started_p50_s=statistics.median(started), started_max_s=started[-1])
    print(json.dumps({"summary": summary}), flush=True)


if __name__ == "__main__":
    main()
