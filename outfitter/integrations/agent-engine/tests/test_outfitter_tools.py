import asyncio
import dataclasses
import json
import socket
import time

import httpx
import pytest

import outfitter_tools as ot
import fake_a2a_server
from fake_a2a_server import EXT, KEY


def test_start_poll_completed(config):
    started = ot.outfitter_start("Fix the pager off-by-one", config=config)
    assert "error" not in started, started
    assert started["state"] == "submitted"
    assert started["task_id"] and started["context_id"]
    assert "result" not in started

    working = ot.outfitter_status(started["task_id"], config=config)
    assert working["state"] == "working"
    assert working["status_text"] == "running tests"
    assert working["task_id"] == started["task_id"]
    assert working["context_id"] == started["context_id"]
    assert "result" not in working

    done = ot.outfitter_status(started["task_id"], config=config)
    assert done["state"] == "completed"
    assert done["state"] in ot.TERMINAL_STATES
    assert done["result"] == {
        "summary": "Fixed the off-by-one in pager.ts and added a test.",
        "branch": "outfitter/a2a-1234abcd",
        "head": "0123456789abcdef0123456789abcdef01234567",
        "compare_url": "https://github.com/owner/repo/compare/main...outfitter/a2a-1234abcd",
        "pr_url": "https://github.com/owner/repo/pull/7",
    }


def test_extension_params_reach_the_server(config, rpc_posts):
    started = ot.outfitter_start("Add a test", skill="a2a-coder", repo="owner/repo",
                                 base_branch="develop", config=config)
    assert started["state"] == "submitted"
    (send,) = rpc_posts()
    headers = {k.lower(): v for k, v in send["headers"].items()}
    assert headers["authorization"] == f"Bearer {KEY}"
    assert headers["a2a-version"] == "1.0"
    assert EXT in [e.strip() for e in headers["a2a-extensions"].split(",")]
    body = send["body"]
    assert body["jsonrpc"] == "2.0" and body["method"] == "SendMessage"
    params = body["params"]
    assert params["configuration"] == {"returnImmediately": True, "historyLength": 0}
    message = params["message"]
    assert message["role"] == "ROLE_USER"
    assert message["parts"] == [{"text": "Add a test"}]
    assert message["messageId"]
    assert "taskId" not in message and "contextId" not in message
    assert message["metadata"] == {EXT: {"skill": "a2a-coder", "repo": "owner/repo",
                                         "baseBranch": "develop"}}
    assert message["extensions"] == [EXT]


def test_no_extension_without_params(config, rpc_posts):
    ot.outfitter_start("Just do it", config=config)
    (send,) = rpc_posts()
    headers = {k.lower(): v for k, v in send["headers"].items()}
    assert "a2a-extensions" not in headers
    message = send["body"]["params"]["message"]
    assert "metadata" not in message and "extensions" not in message


def test_status_sends_get_task_with_key(config, rpc_posts):
    started = ot.outfitter_start("Fix it", config=config)
    ot.outfitter_status(started["task_id"], config=config)
    get = rpc_posts()[-1]
    assert get["body"]["method"] == "GetTask"
    assert get["body"]["params"] == {"id": started["task_id"], "historyLength": 0}
    assert {k.lower(): v for k, v in get["headers"].items()}["authorization"] == f"Bearer {KEY}"


def test_auth_failure(config):
    bad = dataclasses.replace(config, api_key="outf_wrong")
    result = ot.outfitter_start("Fix it", config=bad)
    assert result["error"]["kind"] == "auth"
    assert "401" in result["error"]["message"]
    assert "90 days" in result["error"]["message"]
    assert "outf_wrong" not in json.dumps(result)
    assert ot.outfitter_status("0b4f5c1e-0000-4000-8000-000000000000", config=bad)["error"]["kind"] == "auth"


def test_rejected_task(config):
    result = ot.outfitter_start("please reject this", repo="other/repo", config=config)
    assert "error" not in result
    assert result["state"] == "rejected"
    assert result["state"] in ot.TERMINAL_STATES
    assert result["status_text"] == "repo other/repo is not allowed for this key"
    # A rejected task stays rejected.
    assert ot.outfitter_status(result["task_id"], config=config)["state"] == "rejected"


def test_send_timeout(server, config):
    server.send_delay = 3.0
    fast = dataclasses.replace(config, timeout=httpx.Timeout(0.5, connect=0.5))
    t0 = time.monotonic()
    result = ot.outfitter_start("Fix it", config=fast)
    assert time.monotonic() - t0 < 2.5
    assert result["error"]["kind"] == "timeout"
    assert "may have been created" in result["error"]["message"]
    assert KEY not in json.dumps(result)


def test_overall_deadline(server, config):
    server.send_delay = 3.0
    short = dataclasses.replace(config, timeout=httpx.Timeout(10.0), deadline_seconds=0.5)
    t0 = time.monotonic()
    result = ot.outfitter_start("Fix it", config=short)
    assert time.monotonic() - t0 < 2.5
    assert result["error"]["kind"] == "timeout"


def test_unknown_task(config):
    result = ot.outfitter_status("0b4f5c1e-0000-4000-8000-000000000000", config=config)
    assert result["error"]["kind"] == "not_found"


@pytest.mark.parametrize("status,kind", [(503, "unavailable"), (500, "unavailable"),
                                         (429, "rate_limited"), (403, "auth")])
def test_http_failures(server, config, status, kind):
    server.fail_status = status
    assert ot.outfitter_start("Fix it", config=config)["error"]["kind"] == kind


def test_server_invalid_params(config, monkeypatch):
    # Lift the local length cap so the request reaches the server's -32602.
    monkeypatch.setattr(ot, "MAX_TASK_CHARS", 10**9)
    result = ot.outfitter_start("x" * 32_001, config=config)
    assert result["error"]["kind"] == "invalid"
    assert "too long" in result["error"]["message"]


def test_message_instead_of_task(config):
    result = ot.outfitter_start("reply as-message please", config=config)
    assert result["error"]["kind"] == "protocol"


def test_unreachable(config):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    gone = dataclasses.replace(config, base_url=f"http://127.0.0.1:{port}")
    result = ot.outfitter_start("Fix it", config=gone)
    assert result["error"]["kind"] == "unavailable" and KEY not in json.dumps(result)


@pytest.fixture
def other_server():
    srv = fake_a2a_server.start()
    yield srv
    srv.shutdown()
    srv.server_close()


@pytest.mark.parametrize("mixed", [False, True])
def test_card_pointing_elsewhere_gets_no_key(server, other_server, config, rpc_posts, mixed):
    foreign = {"url": f"{other_server.base_url}/a2a", "protocolBinding": "JSONRPC",
               "protocolVersion": "1.0"}
    own = {"url": f"{server.base_url}/a2a", "protocolBinding": "JSONRPC", "protocolVersion": "1.0"}
    server.interfaces = [own, foreign] if mixed else [foreign]
    result = ot.outfitter_start("Fix it", config=config)
    assert result["error"]["kind"] == "config"
    assert "refusing to send the key" in result["error"]["message"]
    assert rpc_posts() == []
    assert other_server.requests == []  # a live server on the foreign origin saw nothing


def test_card_without_a_v1_interface(server, config, rpc_posts):
    server.interfaces = [{"url": f"{server.base_url}/a2a", "protocolBinding": "JSONRPC",
                          "protocolVersion": "0.3"}]
    assert ot.outfitter_start("Fix it", config=config)["error"]["kind"] == "protocol"
    assert rpc_posts() == []


def test_card_redirect_is_config(server, config):
    server.card_redirect = "https://example.com/.well-known/agent-card.json"
    assert ot.outfitter_start("Fix it", config=config)["error"]["kind"] == "config"


@pytest.mark.parametrize("code,kind", [(-32600, "invalid"), (-32004, "invalid"), (-32005, "invalid"),
                                       (-32602, "invalid"), (-32001, "not_found"),
                                       (-32009, "protocol"), (-32603, "protocol"),
                                       (-31999, "protocol")])
def test_jsonrpc_error_codes(server, config, code, kind):
    server.rpc_error_code = code
    result = ot.outfitter_start("Fix it", config=config)
    assert result["error"]["kind"] == kind
    assert KEY not in json.dumps(result)


def test_long_server_text_is_capped(server, config, monkeypatch):
    started = ot.outfitter_start("Fix it", config=config)
    server.tasks[started["task_id"]]["status"] = fake_a2a_server._status(
        "TASK_STATE_WORKING", "y" * 50_000)
    server.tasks[started["task_id"]]["step"] = 99  # keep it from advancing
    monkeypatch.setattr(server, "get_task", lambda params: server.task_json(params["id"]))
    status = ot.outfitter_status(started["task_id"], config=config)
    assert len(status["status_text"]) < ot.MAX_TEXT_CHARS + 20
    assert status["status_text"].endswith("(truncated)")


def test_card_wrong_path_is_config(config):
    wrong = dataclasses.replace(config, base_url=config.base_url + "/nope")
    assert ot.outfitter_start("Fix it", config=wrong)["error"]["kind"] == "config"


@pytest.mark.parametrize("kwargs,needle", [
    ({"task": "  "}, "empty"),
    ({"task": "x" * 32_001}, "longer"),
    ({"task": "ok", "repo": "not a repo"}, "owner/name"),
    ({"task": "ok", "skill": "tape id\n"}, "tape id"),
    ({"task": "ok", "skill": "x" * 65}, "tape id"),
    ({"task": "ok", "base_branch": "main..evil"}, "branch"),
    ({"task": "ok", "base_branch": "has space"}, "branch"),
])
def test_local_validation_makes_no_calls(server, config, kwargs, needle):
    result = ot.outfitter_start(**kwargs, config=config)
    assert result["error"]["kind"] == "invalid" and needle in result["error"]["message"]
    assert server.requests == []


@pytest.mark.parametrize("task_id", ["", "../etc", "a" * 129, "has space"])
def test_bad_task_id(server, config, task_id):
    assert ot.outfitter_status(task_id, config=config)["error"]["kind"] == "invalid"
    assert server.requests == []


def test_config_from_env(monkeypatch, server):
    monkeypatch.delenv(ot.ENV_URL, raising=False)
    monkeypatch.delenv(ot.ENV_KEY, raising=False)
    assert ot.outfitter_start("x")["error"]["kind"] == "config"
    monkeypatch.setenv(ot.ENV_URL, "http://link.kernal.one")
    monkeypatch.setenv(ot.ENV_KEY, KEY)
    result = ot.outfitter_start("x")
    assert result["error"]["kind"] == "config" and "https" in result["error"]["message"]
    monkeypatch.setenv(ot.ENV_URL, server.base_url + "/")
    assert ot.outfitter_start("Fix it")["state"] == "submitted"
    assert KEY not in repr(ot.OutfitterConfig.from_env())


def test_works_inside_a_running_loop(config):
    async def inside():
        return ot.outfitter_start("Fix it", config=config)

    assert asyncio.run(inside())["state"] == "submitted"


class _FakeApp:
    def __init__(self):
        self.tools = {}

    def tool(self, *args, **kwargs):
        assert not args and set(kwargs) == {"timeout"}, (args, kwargs)

        def wrap(fn):
            self.tools[fn.__name__] = (fn, kwargs)
            return fn

        return wrap


def test_register_tools(monkeypatch, server):
    monkeypatch.setenv(ot.ENV_URL, server.base_url)
    monkeypatch.setenv(ot.ENV_KEY, KEY)
    app = _FakeApp()
    ot.register_tools(app)
    assert set(app.tools) == {"outfitter_start", "outfitter_status"}
    start, start_kwargs = app.tools["outfitter_start"]
    status, _ = app.tools["outfitter_status"]
    assert start_kwargs == {"timeout": 30}
    assert start.__doc__ and "task_id" in start.__doc__ and status.__doc__
    started = json.loads(start("Fix it", skill=None, repo="owner/repo", base_branch=None))
    assert started["state"] == "submitted"
    assert json.loads(status(started["task_id"]))["state"] == "working"
    assert json.loads(status("nope nope"))["error"]["kind"] == "invalid"
