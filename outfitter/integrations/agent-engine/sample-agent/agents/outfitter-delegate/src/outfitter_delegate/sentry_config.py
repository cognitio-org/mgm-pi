"""Sentry (error reporting + tracing) for the Agent Engine Python runtime.

Off unless ``SENTRY_DSN`` is set in this agent's own environment (its agent.yaml / deploy env).
Every other Outfitter runtime takes its Sentry settings from the fleet settings an operator sets in
the web app (``outfitter/packages/api/src/fleet-settings.ts``); this one cannot yet, because it has
no channel to the Outfitter API when it starts. So the DSN is not a source default here: an agent
deployed without one sends nothing.

- Errors are always captured (``sample_rate=1.0``); only performance traces are sampled down
  (``SENTRY_TRACES_SAMPLE_RATE``, default 0.05) to stay inside a free-tier quota.
- The Agent Engine runner has its own opt-in Sentry (``AGENTIC_SENTRY_ENABLED=1`` with
  ``AGENTIC_SENTRY_DSN``, in agent-engine-runner-shared's error_reporting.py). When it is already
  on, this reuses that client instead of replacing it: a second ``sentry_sdk.init`` would silently
  take over the runner's own reporting.

Call ``init_sentry()`` once, as early as possible in the entrypoint (``outfitter_delegate.main``,
which agent.yaml's single entrypoint imports for both the AER and the tool sandbox).
"""

from __future__ import annotations

import logging
import os
from typing import Any

import sentry_sdk

logger = logging.getLogger(__name__)

# Errors: always captured. Traces: 5% unless SENTRY_TRACES_SAMPLE_RATE says otherwise (the fleet's
# default; see docs/reports/sentry-integration-plan.md).
SAMPLE_RATE = 1.0
DEFAULT_TRACES_SAMPLE_RATE = 0.05

_initialized = False


def _traces_sample_rate() -> float:
    raw = os.environ.get("SENTRY_TRACES_SAMPLE_RATE", "").strip()
    try:
        rate = float(raw) if raw else DEFAULT_TRACES_SAMPLE_RATE
    except ValueError:
        return DEFAULT_TRACES_SAMPLE_RATE
    return min(1.0, max(0.0, rate))


def init_sentry(*, dsn: str | None = None, environment: str | None = None) -> bool:
    """Starts the Sentry Python SDK for this process. Returns whether Sentry is on afterwards.

    ``dsn`` defaults to the ``SENTRY_DSN`` environment variable; unset or empty means off.
    ``environment`` defaults to ``SENTRY_ENVIRONMENT``, then ``"production"``.

    Safe to call more than once: only the first call takes effect, matching the Node.js and browser
    Sentry modules in this repo, so agent code doesn't need an "is Sentry already on" branch.
    """
    global _initialized
    if _initialized:
        return True

    if sentry_sdk.get_client().is_active():
        # The runner started Sentry first (see the module docstring): report through its client.
        _initialized = True
        return True

    resolved_dsn = (dsn if dsn is not None else os.environ.get("SENTRY_DSN", "")).strip()
    if not resolved_dsn:
        return False

    sentry_sdk.init(
        dsn=resolved_dsn,
        environment=environment or os.environ.get("SENTRY_ENVIRONMENT") or "production",
        sample_rate=SAMPLE_RATE,
        traces_sample_rate=_traces_sample_rate(),
    )
    _initialized = True
    return True


def sentry_enabled() -> bool:
    """Whether ``init_sentry()`` has started (or adopted) the SDK in this process."""
    return _initialized


def capture_exception(error: BaseException, context: dict[str, Any] | None = None) -> None:
    """Reports an exception Sentry wouldn't otherwise see (e.g. one caught and handled outside
    a traced span). A no-op when Sentry is off, so call sites don't need to branch on
    ``sentry_enabled()``."""
    if not _initialized:
        return
    if context:
        with sentry_sdk.new_scope() as scope:
            for key, value in context.items():
                scope.set_extra(key, value)
            sentry_sdk.capture_exception(error)
    else:
        sentry_sdk.capture_exception(error)


def reset_sentry_for_tests() -> None:
    """Test-only: clears the SDK client and the module's "already initialized" guard so each
    test gets a clean slate, matching ``resetSentryForTests`` in ``sentry.ts``."""
    global _initialized
    sentry_sdk.get_global_scope().set_client(None)
    _initialized = False
