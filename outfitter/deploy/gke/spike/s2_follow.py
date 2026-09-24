#!/usr/bin/env python3
"""Spike S2: follow the S2 pod's agentd log into s2-agentd.txt (kubelet timestamps kept) and echo
the lines worth acting on: startup phases, link/hello/run state, errors, and the pod's exit.

    python3 s2_follow.py <pod> [timeout_s]    # default 1800
"""
import os
import re
import subprocess
import sys
import time

pod = sys.argv[1]
timeout = int(sys.argv[2]) if len(sys.argv) > 2 else 1800
here = os.path.dirname(os.path.abspath(__file__))
env = dict(os.environ, CLOUDSDK_ACTIVE_CONFIG_NAME="outfitter")
base = ["kubectl", f"--kubeconfig={os.path.expanduser('~/.kube/outfitter')}", "-n", "outfitter-sandboxes"]
interesting = re.compile(r'phase|startup|hello|connected|link|run\.spec|state|idle|running|restore|clone|'
                         r'pi |spawn|error|ERROR|fatal|WARN|bye|stop|exit|SIGTERM', re.I)

start = time.time()
while time.time() - start < timeout:  # wait for the container to start
    phase = subprocess.run(base + ["get", "pod", pod, "-o", "jsonpath={.status.phase}"],
                           capture_output=True, text=True, env=env).stdout
    if phase in ("Running", "Succeeded", "Failed"):
        print(f"pod {phase} after {time.time() - start:.0f}s of watching", flush=True)
        break
    time.sleep(3)

with open(os.path.join(here, "s2-agentd.txt"), "w") as log:  # .txt: *.log is gitignored
    p = subprocess.Popen(base + ["logs", "-f", "--timestamps", pod], stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, text=True, env=env)
    for line in p.stdout:
        log.write(line)
        log.flush()
        if interesting.search(line):
            print(line.rstrip()[:300], flush=True)
        if time.time() - start > timeout:
            p.kill()
            break
print("log stream ended", flush=True)
