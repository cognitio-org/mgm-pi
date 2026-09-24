#!/usr/bin/env python3
"""Wait for the pod with label app=<app> in <namespace> to finish, then print its log.

    python3 waitpod.py <namespace> <app> [timeout_s]
Prints the phase changes with elapsed seconds, then the log. Exit 1 on timeout or Failed.
"""
import json
import os
import subprocess
import sys
import time

ns, app = sys.argv[1], sys.argv[2]
timeout = int(sys.argv[3]) if len(sys.argv) > 3 else 600
base = ["kubectl", f"--kubeconfig={os.path.expanduser('~/.kube/outfitter')}", "-n", ns]
env = dict(os.environ, CLOUDSDK_ACTIVE_CONFIG_NAME="outfitter")

start, last, pod = time.time(), None, None
while time.time() - start < timeout:
    out = subprocess.run(base + ["get", "pods", "-l", f"app={app}", "-o", "json"],
                         capture_output=True, text=True, env=env).stdout
    items = json.loads(out or '{"items": []}')["items"]
    phase = items[0]["status"].get("phase") if items else "no pod yet"
    if phase != last:
        print(f"{time.time() - start:6.1f}s  {phase}", flush=True)
        last = phase
    if items and phase in ("Succeeded", "Failed"):
        pod = items[0]["metadata"]["name"]
        break
    time.sleep(2)
else:
    print("timeout", flush=True)
    sys.exit(1)

print(subprocess.run(base + ["logs", pod], capture_output=True, text=True, env=env).stdout, flush=True)
sys.exit(0 if last == "Succeeded" else 1)
