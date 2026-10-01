"""A tiny fake of Outfitter's A2A v1.0 server (spec §5), for the tool tests.

Standard library only, and the wire JSON is written out by hand rather than produced by a2a-sdk,
so the tests check the client against the contract PR5/PR6 must serve, not against itself:

- ``GET /.well-known/agent-card.json``: the public card (no auth).
- ``POST /a2a``: JSON-RPC 2.0 with ``Authorization: Bearer <key>`` (HTTP 401 otherwise) and
  ``A2A-Version: 1.0`` (-32009 otherwise). Methods ``SendMessage`` and ``GetTask``.

Scripted by the task text:
- contains ``reject``: the task comes back ``TASK_STATE_REJECTED`` with a reason.
- contains ``as-message``: SendMessage answers with a Message instead of a Task.
- anything else: ``TASK_STATE_SUBMITTED``; each GetTask then advances it one step:
  WORKING ("running tests"), then COMPLETED with the result artifact.

Knobs on the server object: ``send_delay`` (seconds to stall SendMessage), ``card_url`` (where
the card's interface points), ``fail_status`` (an HTTP status for every JSON-RPC call).
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

EXT = "https://kernal.one/a2a/ext/outfitter-task/v1"
KEY = "outf_test_key_not_real"


def _status(state: str, text: str | None = None) -> dict[str, Any]:
    status: dict[str, Any] = {"state": state, "timestamp": "2026-10-01T00:00:00Z"}
    if text:
        status["message"] = {
            "messageId": str(uuid.uuid4()),
            "role": "ROLE_AGENT",
            "parts": [{"text": text}],
        }
    return status


class FakeOutfitter(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), _Handler)
        self.base_url = f"http://127.0.0.1:{self.server_address[1]}"
        self.card_url = f"{self.base_url}/a2a"
        self.send_delay = 0.0
        self.fail_status: int | None = None
        self.requests: list[dict[str, Any]] = []
        self.tasks: dict[str, dict[str, Any]] = {}
        self.lock = threading.Lock()

    def handle_error(self, request: Any, client_address: Any) -> None:
        pass  # a client that timed out leaves a broken pipe behind; that's the point of the test

    def card(self) -> dict[str, Any]:
        return {
            "name": "Outfitter",
            "description": "Coding agent. Send returnImmediately: true; poll GetTask or stream.",
            "version": "test",
            "provider": {"organization": "Kernal", "url": "https://kernal.one"},
            "supportedInterfaces": [
                {"url": self.card_url, "protocolBinding": "JSONRPC", "protocolVersion": "1.0"}
            ],
            "defaultInputModes": ["text/plain", "application/json"],
            "defaultOutputModes": ["text/plain", "application/json"],
            "capabilities": {
                "streaming": True,
                "pushNotifications": False,
                "extendedAgentCard": True,
                "extensions": [{"uri": EXT, "description": "tape and repo", "required": False}],
            },
            "securitySchemes": {"outfitterKey": {"httpAuthSecurityScheme": {"scheme": "Bearer"}}},
            "securityRequirements": [{"schemes": {"outfitterKey": {"list": []}}}],
            "skills": [{"id": "coding", "name": "Coding", "description": "Coding tasks",
                        "tags": ["coding", "git"]}],
        }

    def task_json(self, task_id: str) -> dict[str, Any]:
        t = self.tasks[task_id]
        out = {"id": task_id, "contextId": t["contextId"], "status": t["status"]}
        if t.get("artifacts"):
            out["artifacts"] = t["artifacts"]
        return out

    def send_message(self, params: dict[str, Any]) -> dict[str, Any]:
        message = params.get("message", {})
        text = "".join(p.get("text", "") for p in message.get("parts", []))
        if "as-message" in text:
            return {"message": {"messageId": str(uuid.uuid4()), "role": "ROLE_AGENT",
                                "parts": [{"text": "hello, no task here"}]}}
        task_id, context_id = str(uuid.uuid4()), str(uuid.uuid4())
        if "reject" in text:
            status = _status("TASK_STATE_REJECTED", "repo other/repo is not allowed for this key")
        else:
            status = _status("TASK_STATE_SUBMITTED")
        with self.lock:
            self.tasks[task_id] = {"contextId": context_id, "status": status, "step": 0}
        return {"task": self.task_json(task_id)}

    def get_task(self, params: dict[str, Any]) -> dict[str, Any] | None:
        task_id = params.get("id", "")
        with self.lock:
            t = self.tasks.get(task_id)
            if t is None:
                return None
            if t["status"]["state"] not in ("TASK_STATE_REJECTED", "TASK_STATE_COMPLETED"):
                t["step"] += 1
                if t["step"] == 1:
                    t["status"] = _status("TASK_STATE_WORKING", "running tests")
                else:
                    t["artifacts"] = [{
                        "artifactId": str(uuid.uuid4()),
                        "name": "result",
                        "parts": [
                            {"text": "Fixed the off-by-one in pager.ts and added a test."},
                            {"data": {
                                "branch": "outfitter/a2a-1234abcd",
                                "head": "0123456789abcdef0123456789abcdef01234567",
                                "compareUrl": "https://github.com/owner/repo/compare/main...outfitter/a2a-1234abcd",
                                "prUrl": "https://github.com/owner/repo/pull/7",
                            }, "mediaType": "application/json"},
                        ],
                    }]
                    t["status"] = _status("TASK_STATE_COMPLETED", "done")
            return self.task_json(task_id)


class _Handler(BaseHTTPRequestHandler):
    server: FakeOutfitter

    def log_message(self, *args: Any) -> None:  # keep pytest output clean
        pass

    def _reply(self, code: int, body: dict[str, Any], headers: dict[str, str] | None = None) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        self.server.requests.append({"method": "GET", "path": self.path, "headers": dict(self.headers)})
        if self.path == "/.well-known/agent-card.json":
            self._reply(200, self.server.card(), {"Access-Control-Allow-Origin": "*"})
        else:
            self._reply(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            body = None
        self.server.requests.append(
            {"method": "POST", "path": self.path, "headers": dict(self.headers), "body": body})
        if self.path.rstrip("/") != "/a2a":
            return self._reply(404, {"error": "not found"})
        if self.headers.get("Authorization") != f"Bearer {KEY}":
            return self._reply(401, {"error": "unauthorized"})
        if self.server.fail_status:
            return self._reply(self.server.fail_status, {"error": "failing on purpose"})
        if self.server.send_delay and body and body.get("method") == "SendMessage":
            time.sleep(self.server.send_delay)
        if not isinstance(body, dict) or body.get("jsonrpc") != "2.0":
            return self._reply(200, {"jsonrpc": "2.0", "id": None,
                                     "error": {"code": -32700, "message": "parse error"}})
        rpc_id = body.get("id")

        def error(code: int, message: str) -> None:
            self._reply(200, {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": code, "message": message}})

        if self.headers.get("A2A-Version") != "1.0":
            return error(-32009, "version not supported")
        method, params = body.get("method"), body.get("params") or {}
        headers: dict[str, str] = {}
        requested = [e.strip() for e in self.headers.get("A2A-Extensions", "").split(",") if e.strip()]
        if EXT in requested:
            headers["A2A-Extensions"] = EXT
        if method == "SendMessage":
            text = "".join(p.get("text", "") for p in params.get("message", {}).get("parts", []))
            if len(text) > 32_000:
                return error(-32602, "prompt text too long")
            result = self.server.send_message(params)
        elif method == "GetTask":
            result = self.server.get_task(params)
            if result is None:
                return error(-32001, "task not found")
        else:
            return error(-32601, "method not found")
        self._reply(200, {"jsonrpc": "2.0", "id": rpc_id, "result": result}, headers)


def start() -> FakeOutfitter:
    server = FakeOutfitter()
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
    return server
