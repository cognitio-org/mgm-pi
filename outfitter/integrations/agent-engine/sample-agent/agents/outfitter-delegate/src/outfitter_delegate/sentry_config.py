"""Sentry (error reporting + tracing) for the Agent Engine Python runtime.

Mirrors the pattern already used by the other Outfitter runtimes (``outfitter/packages/api/src/
sentry.ts``, ``outfitter/packages/web/src/lib/sentry.ts``): one ``init_sentry()`` call, gated on a
DSN, that every other helper in this module degrades harmlessly around when Sentry never started.

- ``DEFAULT_DSN`` is this project's Sentry DSN. DSNs are not secrets (they're already public in
  the web bundle at ``outfitter/packages/web/src/lib/sentry.ts``), so shipping it as a source
  default is fine; ``SENTRY_DSN`` in the environment overrides it, and an explicit empty string
  disables Sentry entirely (useful for local dev/tests that must not phone home).
- Errors are always captured (``sample_rate=1.0``); only performance traces are sampled down
  (``traces_sample_rate=0.05``) to stay inside a free-tier transaction quota. See
  ``docs/reports/sentry-integration-plan.md`` for the quota rationale shared across runtimes.

Call ``init_sentry()`` once, as early as possible in each entrypoint (``outfitter_delegate.main``
for the sample agent's AER process; ``register_tools`` for the tool-sandbox process that runs
``outfitter_start``/``outfitter_status``), before anything that might raise.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import sentry_sdk

logger = logging.getLogger(__name__)

DEFAULT_DSN = (
    "https://1318f3af9a71b190730c227fb61c32dc@o4512181408432128.ingest.us.sentry.io/4512181422260224"
)

# Errors: always captured. Traces: 5% sampling (owner-specified default; see
# docs/reports/sentry-integration-plan.md). Kept as named constants so a call site that needs to
# print or assert the configured rate (as the tests do) has one place to read them from.
SAMPLE_RATE = 1.0
TRACES_SAMPLE_RATE = 0.05

_initialized = False


def init_sentry(*, dsn: str | None = None, environment: str | None = None) -> bool:
    """Starts the Sentry Python SDK for this process. Returns whether Sentry is enabled
    afterwards.

    ``dsn`` defaults to the ``SENTRY_DSN`` environment variable, then to ``DEFAULT_DSN``; pass
    ``dsn=""`` (or set ``SENTRY_DSN=""``) to disable Sentry outright. ``environment`` defaults to
    the ``SENTRY_ENVIRONMENT`` environment variable, then ``"production"``.

    Safe to call more than once: only the first call takes effect, matching the Node.js and
    browser Sentry modules in this repo (``sentry.ts``, ``lib/sentry.ts``) so agent code doesn't
    need an "is Sentry already on" branch of its own.
    """
    global _initialized
    if _initialized:
        return True

    resolved_dsn = dsn if dsn is not None else os.environ.get("SENTRY_DSN", DEFAULT_DSN)
    resolved_dsn = resolved_dsn.strip()
    if not resolved_dsn:
        return False

    resolved_environment = environment or os.environ.get("SENTRY_ENVIRONMENT") or "production"

    sentry_sdk.init(
        dsn=resolved_dsn,
        environment=resolved_environment,
        sample_rate=SAMPLE_RATE,
        traces_sample_rate=TRACES_SAMPLE_RATE,
    )
    _initialized = True
    return True


def sentry_enabled() -> bool:
    """Whether ``init_sentry()`` has successfully started the SDK in this process."""
    return _initialized


def capture_exception(error: BaseException, context: dict[str, Any] | None = None) -> None:
    """Reports an exception Sentry wouldn't otherwise see (e.g. one caught and handled outside
    a traced span). A no-op when Sentry is off, so call sites don't need to branch on
    ``sentry_enabled()``."""
    if not _initialized:
        return
    if context:
        with sentry_sdk.push_scope() as scope:
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
