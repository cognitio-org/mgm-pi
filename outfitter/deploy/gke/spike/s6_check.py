#!/usr/bin/env python3
"""Spike S6: can outfitter-api@ reach the cluster's DNS endpoint with only its IAM role
(roles/container.clusterViewer) and the namespaced RBAC in deploy/gke/rbac.yaml?

Gets an access token by impersonating outfitter-api@ (needs roles/iam.serviceAccountTokenCreator
for the caller on that account, granted temporarily for this check), then calls the Kubernetes
API over the public DNS endpoint with Python's default TLS verification (no CA bundle handed in).
Creates use server-side dry run, so nothing is actually created.

    python3 s6_check.py    # one JSON line per check, then a summary; exit 1 if any check is wrong

A python.org Python on macOS has no CA bundle until its "Install Certificates" step has run, and
fails every check with CERTIFICATE_VERIFY_FAILED. Point it at the system bundle for the run:
    SSL_CERT_FILE=/etc/ssl/cert.pem python3 s6_check.py
(curl verifies the endpoint's certificate against the macOS store without help.)
"""
import json
import subprocess
import sys
import urllib.error
import urllib.request

SA = "outfitter-api@outfitter-509211.iam.gserviceaccount.com"
ENDPOINT = "https://gke-2b39f97f972e4b5aa58649cfda3195ffe3aa-97916961297.us-central1.gke.goog"
NS = "outfitter-sandboxes"
EXT = "/apis/extensions.agents.x-k8s.io/v1beta1"

token = subprocess.run(
    ["gcloud", "--configuration=outfitter", "auth", "print-access-token",
     f"--impersonate-service-account={SA}"],
    capture_output=True, text=True, check=True).stdout.strip()

CLAIM = {
    "apiVersion": "extensions.agents.x-k8s.io/v1beta1", "kind": "SandboxClaim",
    "metadata": {"name": "s6-dry-run", "namespace": NS},
    "spec": {"warmPoolRef": {"name": "s4-coldstart"}, "lifecycle": {"shutdownPolicy": "Delete"}},
}

# (description, method, path, body, expected HTTP status)
CHECKS = [
    ("list claims in outfitter-sandboxes", "GET", f"{EXT}/namespaces/{NS}/sandboxclaims", None, 200),
    ("create a claim (server-side dry run)", "POST",
     f"{EXT}/namespaces/{NS}/sandboxclaims?dryRun=All", CLAIM, 201),
    ("read a warm pool", "GET", f"{EXT}/namespaces/{NS}/sandboxwarmpools/s4-coldstart", None, 200),
    ("resize a warm pool (dry run, same size)", "PATCH",
     f"{EXT}/namespaces/{NS}/sandboxwarmpools/s4-coldstart?dryRun=All", {"spec": {"replicas": 0}}, 200),
    ("list sandboxes (only get is granted)", "GET",
     f"/apis/agents.x-k8s.io/v1beta1/namespaces/{NS}/sandboxes", None, 403),
    ("list pods (no pods access)", "GET", f"/api/v1/namespaces/{NS}/pods", None, 403),
    ("list claims in another namespace", "GET", f"{EXT}/namespaces/outfitter-spike/sandboxclaims", None, 403),
    ("read secrets (none granted)", "GET", f"/api/v1/namespaces/{NS}/secrets", None, 403),
]

wrong = 0
for desc, method, path, body, want in CHECKS:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = ("application/merge-patch+json" if method == "PATCH"
                                   else "application/json")
    req = urllib.request.Request(ENDPOINT + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            status, detail = r.status, ""
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            detail = json.loads(e.read()).get("message", "")[:160]
        except Exception:
            detail = ""
    except Exception as e:  # TLS or network failure: report, count as wrong
        status, detail = None, f"{type(e).__name__}: {e}"[:160]
    ok = status == want
    wrong += not ok
    print(json.dumps({"check": desc, "status": status, "want": want, "ok": ok,
                      **({"detail": detail} if detail and not ok else {})}), flush=True)

print(json.dumps({"summary": {"checks": len(CHECKS), "wrong": wrong}}), flush=True)
sys.exit(1 if wrong else 0)
