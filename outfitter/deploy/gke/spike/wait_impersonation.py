#!/usr/bin/env python3
"""Wait until mgm@mgms.eu can impersonate outfitter-api@ (IAM grants take minutes to propagate).

    python3 wait_impersonation.py [timeout_s]   # default 600; exit 1 on timeout
"""
import subprocess
import sys
import time

timeout = int(sys.argv[1]) if len(sys.argv) > 1 else 600
cmd = ["gcloud", "--configuration=outfitter", "auth", "print-access-token",
       "--impersonate-service-account=outfitter-api@outfitter-509211.iam.gserviceaccount.com"]
start = time.time()
while time.time() - start < timeout:
    if subprocess.run(cmd, capture_output=True).returncode == 0:
        print(f"impersonation works after {time.time() - start:.0f}s", flush=True)
        sys.exit(0)
    time.sleep(20)
print("timeout: impersonation still denied", flush=True)
sys.exit(1)
