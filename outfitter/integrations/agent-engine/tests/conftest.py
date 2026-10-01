import sys
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import fake_a2a_server  # noqa: E402
from outfitter_tools import OutfitterConfig  # noqa: E402


@pytest.fixture
def server():
    srv = fake_a2a_server.start()
    yield srv
    srv.shutdown()
    srv.server_close()


@pytest.fixture
def config(server):
    return OutfitterConfig(
        base_url=server.base_url,
        api_key=fake_a2a_server.KEY,
        timeout=httpx.Timeout(2.0, connect=1.0),
        deadline_seconds=5.0,
    )


@pytest.fixture
def rpc_posts(server):
    """The JSON-RPC requests the fake received, in order."""
    return lambda: [r for r in server.requests if r["method"] == "POST"]
