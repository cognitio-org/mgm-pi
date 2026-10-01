"""pytest plugin for the A2A TCK: adds Authorization from $TCK_AUTH to every httpx request.

The TCK has no auth option (docs/reports/agent-engine-spike.md T1), and every Outfitter /a2a call
needs a Bearer A2A key. Loaded with `-p tck_auth_plugin` (run-tck.sh puts this directory on
PYTHONPATH). The value is never printed.
"""

import os

import httpx

_auth = os.environ.get("TCK_AUTH")
if _auth:
    _send = httpx.Client.send
    _asend = httpx.AsyncClient.send

    def send(self, request, *args, **kwargs):
        request.headers.setdefault("Authorization", _auth)
        return _send(self, request, *args, **kwargs)

    async def asend(self, request, *args, **kwargs):
        request.headers.setdefault("Authorization", _auth)
        return await _asend(self, request, *args, **kwargs)

    httpx.Client.send = send
    httpx.AsyncClient.send = asend
