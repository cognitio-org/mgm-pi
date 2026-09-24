#!/usr/bin/env python3
"""Wait until the cluster has no gVisor sandbox nodes left (Autopilot scaled them down).

    python3 wait_no_sandbox_nodes.py [timeout_s]   # default 3600; prints the wait, exit 1 on timeout
"""
import json
import os
import subprocess
import sys
import time

timeout = int(sys.argv[1]) if len(sys.argv) > 1 else 3600
cmd = ["kubectl", f"--kubeconfig={os.path.expanduser('~/.kube/outfitter')}", "get", "nodes",
       "-l", "sandbox.gke.io/runtime=gvisor", "-o", "json"]
env = dict(os.environ, CLOUDSDK_ACTIVE_CONFIG_NAME="outfitter")
start = time.time()
while time.time() - start < timeout:
    r = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if r.returncode == 0 and not json.loads(r.stdout)["items"]:
        print(f"no sandbox nodes after {time.time() - start:.0f}s", flush=True)
        sys.exit(0)
    time.sleep(30)
print("timeout: sandbox nodes still present", flush=True)
sys.exit(1)
