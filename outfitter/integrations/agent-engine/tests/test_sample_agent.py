"""The outfitter-delegate sample agent: its copy of the tools, its agent.yaml, and (when the Agent
Engine SDK is installed, `uv sync --group sdk`) the real App registering and running the tools."""

import importlib
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

import pytest
import yaml

from fake_a2a_server import KEY

ROOT = Path(__file__).resolve().parents[1]
AGENT = ROOT / "sample-agent" / "agents" / "outfitter-delegate"
PACKAGE = AGENT / "src" / "outfitter_delegate"
TOOLS = {"outfitter_start", "outfitter_status"}


@pytest.fixture(scope="module")
def manifest():
    return yaml.safe_load((AGENT / "agent.yaml").read_text())


def test_tools_copy_is_identical():
    # The agent image packages only the agent directory, so it carries its own copy.
    # After editing outfitter_tools.py: cp outfitter_tools.py sample-agent/agents/outfitter-delegate/src/outfitter_delegate/
    assert (PACKAGE / "outfitter_tools.py").read_bytes() == (ROOT / "outfitter_tools.py").read_bytes()


def test_entrypoint_points_at_the_app(manifest):
    module, attr = manifest["entrypoint"].split(":")
    assert module == "outfitter_delegate.main" and attr == "app"
    assert (PACKAGE / "main.py").exists()
    assert manifest["name"] == "outfitter-delegate"


def test_tools_run_in_the_tool_sandbox_with_the_key(manifest):
    tool = manifest["sandboxes"]["tool"]
    agent = manifest["sandboxes"]["agent"]
    assert set(tool["tools"]) == TOOLS
    assert "OUTFITTER_A2A_KEY" in tool["secrets"] and "OUTFITTER_A2A_URL" in tool["secrets"]
    # The agent sandbox must not be able to read the key.
    assert "*" not in agent.get("secrets", []) and "OUTFITTER_A2A_KEY" not in agent.get("secrets", [])
    assert not set(agent.get("tools", [])) & TOOLS


def test_egress_is_an_allow_list_matching_the_code(manifest):
    tool_net = manifest["sandboxes"]["tool"]["network"]
    agent_net = manifest["sandboxes"]["agent"]["network"]
    assert tool_net["egress_mode"] == "allow_list" and agent_net["egress_mode"] == "allow_list"
    assert [(e["fqdn"], e["ports"]) for e in tool_net["egress"]] == [("link.kernal.one", [443])]

    env = dict(line.split("=", 1) for line in (AGENT / "env.example").read_text().splitlines()
               if line and not line.startswith("#"))
    assert urlsplit(env["OUTFITTER_A2A_URL"]).hostname == "link.kernal.one"

    llm_source = (PACKAGE / "llm.py").read_text()
    for entry in agent_net["egress"]:
        assert f"https://{entry['fqdn']}/" in llm_source


def test_real_sdk_registers_and_runs_the_tools(server, manifest, monkeypatch, tmp_path):
    pytest.importorskip("agent_engine_sdk_langgraph")
    pytest.importorskip("langchain_openai")
    monkeypatch.chdir(tmp_path)  # the runtime writes logs/ into the working directory
    monkeypatch.setenv("RUNNER_MODE", "tool")
    monkeypatch.setenv("OUTFITTER_A2A_URL", server.base_url)
    monkeypatch.setenv("OUTFITTER_A2A_KEY", KEY)
    monkeypatch.syspath_prepend(str(AGENT / "src"))
    for name in [m for m in sys.modules if m.startswith("outfitter_delegate")]:
        monkeypatch.delitem(sys.modules, name)
    main = importlib.import_module("outfitter_delegate.main")

    tools = {t.name: t for t in main.app.get_tools()}
    assert set(tools) == TOOLS == set(manifest["sandboxes"]["tool"]["tools"])
    assert set(tools["outfitter_start"].args) == {"task", "skill", "repo", "base_branch"}
    assert set(tools["outfitter_status"].args) == {"task_id"}

    # What the tool sandbox calls: the raw function the SDK registered under the tool's name.
    # (A private attribute of agent-engine-runner-shared 0.11.x; adjust if it moves.)
    raw = main.app._runtime._tools
    assert main.app._runtime.get_tool_metadata("outfitter_start")["timeout_seconds"] == 30
    started = json.loads(raw["outfitter_start"](task="Fix it", repo="owner/repo"))
    assert started["state"] == "submitted"
    assert json.loads(raw["outfitter_status"](task_id=started["task_id"]))["state"] == "working"
