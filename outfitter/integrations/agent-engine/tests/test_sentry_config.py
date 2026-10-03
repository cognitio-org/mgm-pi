"""sentry_config.py: env-only Sentry for the Agent Engine agent. Off without SENTRY_DSN; the trace
rate is parsed and clamped; a client the runner already started is reused, never replaced."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
import sentry_sdk

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sample-agent/agents/outfitter-delegate/src"))

from outfitter_delegate import sentry_config  # noqa: E402

DSN = "https://publicKey@o0.ingest.sentry.io/1"


@pytest.fixture(autouse=True)
def clean(monkeypatch: pytest.MonkeyPatch):
    for name in ("SENTRY_DSN", "SENTRY_ENVIRONMENT", "SENTRY_TRACES_SAMPLE_RATE"):
        monkeypatch.delenv(name, raising=False)
    sentry_config.reset_sentry_for_tests()
    yield
    sentry_config.reset_sentry_for_tests()


def test_off_without_a_dsn():
    assert sentry_config.init_sentry() is False
    assert sentry_config.sentry_enabled() is False
    assert not sentry_sdk.get_client().is_active()
    sentry_config.capture_exception(RuntimeError("ignored"))  # a no-op, never raises


def test_on_with_sentry_dsn(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SENTRY_DSN", DSN)
    monkeypatch.setenv("SENTRY_TRACES_SAMPLE_RATE", "0.25")
    assert sentry_config.init_sentry() is True
    options = sentry_sdk.get_client().options
    assert options["dsn"] == DSN
    assert options["traces_sample_rate"] == 0.25
    assert options["environment"] == "production"


@pytest.mark.parametrize(("raw", "rate"), [("", 0.05), ("nope", 0.05), ("7", 1.0), ("-1", 0.0), ("0.3", 0.3)])
def test_trace_rate_is_parsed_and_clamped(monkeypatch: pytest.MonkeyPatch, raw: str, rate: float):
    monkeypatch.setenv("SENTRY_TRACES_SAMPLE_RATE", raw)
    assert sentry_config._traces_sample_rate() == rate


def test_reuses_a_client_the_runner_already_started(monkeypatch: pytest.MonkeyPatch):
    sentry_sdk.init(dsn="https://runnerKey@o0.ingest.sentry.io/2")
    monkeypatch.setenv("SENTRY_DSN", DSN)
    assert sentry_config.init_sentry() is True
    assert sentry_sdk.get_client().options["dsn"] == "https://runnerKey@o0.ingest.sentry.io/2", "not replaced"
