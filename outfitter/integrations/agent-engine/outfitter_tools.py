"""Hand a coding task to Outfitter over A2A v1.0, and check on it later.

Two operations, for an agent (Agent Engine or any other) that wants Outfitter to do coding work:

- ``outfitter_start(task, skill, repo, base_branch)`` sends the task and returns at once with
  ``{task_id, context_id, state, status_text}``. A coding task runs for minutes, far longer than
  one tool call should hold a sandbox, so this never waits for the work.
- ``outfitter_status(task_id)`` reads the task back: ``{task_id, context_id, state, status_text,
  result?}``, where ``result`` is ``{summary, branch, head, compare_url, pr_url?}`` once
  Outfitter has published it.

Both return a dict and never raise. A failure comes back as ``{"error": {"kind", "message"}}``
so the model calling the tool can read it and tell the user (kinds are listed on
``OutfitterError``).

The A2A logic is plain ``a2a-sdk`` 1.2.1 and ``httpx`` with no Agent Engine imports, so it runs
and is tested anywhere. ``register_tools(app)`` at the bottom is the thin Agent Engine adapter.

Configuration comes from the environment (Agent Engine delivers secrets as environment
variables in the sandbox that runs the tools):

- ``OUTFITTER_A2A_URL``: Outfitter's public link origin, e.g. ``https://link.kernal.one``. The
  Agent Card is read from ``<url>/.well-known/agent-card.json``.
- ``OUTFITTER_A2A_KEY``: an Outfitter A2A key (``outf_...``), sent as ``Authorization: Bearer``.

Keep this file identical to ``sample-agent/agents/outfitter-delegate/src/outfitter_delegate/
outfitter_tools.py`` (the agent image only packages its own directory); a test checks it.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
import os
import re
import uuid
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import httpx
from google.protobuf import json_format
from google.protobuf.struct_pb2 import Struct

from a2a.client import (
    A2ACardResolver,
    A2AClientError,
    A2AClientTimeoutError,
    AgentCardResolutionError,
    ClientCallContext,
    ClientConfig,
    ClientFactory,
)
from a2a.client.service_parameters import ServiceParametersFactory, with_a2a_extensions
from a2a.types import (
    AgentCard,
    GetTaskRequest,
    Message,
    Part,
    Role,
    SendMessageRequest,
    Task,
    TaskState,
)
from a2a.utils.errors import (
    A2AError,
    ContentTypeNotSupportedError,
    InvalidParamsError,
    InvalidRequestError,
    TaskNotFoundError,
    UnsupportedOperationError,
)

EXTENSION_URI = "https://kernal.one/a2a/ext/outfitter-task/v1"
ENV_URL = "OUTFITTER_A2A_URL"
ENV_KEY = "OUTFITTER_A2A_KEY"

# Outfitter caps prompt text at MAIL_MAX_TEXT (32,000 characters, -32602 beyond); fail fast here.
MAX_TASK_CHARS = 32_000
_REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

# Every JSON-RPC call to Outfitter should answer in well under a second (returnImmediately on
# SendMessage, a row read on GetTask). These bound a stuck network or server. The overall
# deadline also covers the card fetch, and stays under the tool's 30 s timeout in Agent Engine.
DEFAULT_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
DEFAULT_DEADLINE_SECONDS = 20.0

_STATE_NAMES = {
    TaskState.TASK_STATE_SUBMITTED: "submitted",
    TaskState.TASK_STATE_WORKING: "working",
    TaskState.TASK_STATE_INPUT_REQUIRED: "input_required",
    TaskState.TASK_STATE_AUTH_REQUIRED: "auth_required",
    TaskState.TASK_STATE_COMPLETED: "completed",
    TaskState.TASK_STATE_FAILED: "failed",
    TaskState.TASK_STATE_CANCELED: "canceled",
    TaskState.TASK_STATE_REJECTED: "rejected",
}
TERMINAL_STATES = frozenset({"completed", "failed", "canceled", "rejected"})


class OutfitterError(Exception):
    """A failure talking to Outfitter. ``kind`` is one of:

    - ``config``: ``OUTFITTER_A2A_URL``/``OUTFITTER_A2A_KEY`` missing or unusable, or the card
      points somewhere other than the configured origin.
    - ``invalid``: the arguments were refused, here or by Outfitter (-32602 and friends).
    - ``auth``: Outfitter refused the key (HTTP 401/403): missing, revoked or expired.
    - ``not_found``: no such task for this key (-32001).
    - ``rate_limited``: HTTP 429.
    - ``timeout``: no answer in time. For a start, the task may still have been created.
    - ``unavailable``: network failure or an HTTP 5xx.
    - ``protocol``: anything else the server said that this client doesn't understand.
    """

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message

    def to_dict(self) -> dict[str, Any]:
        return {"error": {"kind": self.kind, "message": self.message}}


@dataclass(frozen=True)
class OutfitterConfig:
    base_url: str
    api_key: str = field(repr=False)
    timeout: httpx.Timeout = field(default_factory=lambda: DEFAULT_TIMEOUT)
    deadline_seconds: float = DEFAULT_DEADLINE_SECONDS

    @classmethod
    def from_env(cls) -> OutfitterConfig:
        base_url = os.environ.get(ENV_URL, "").strip().rstrip("/")
        api_key = os.environ.get(ENV_KEY, "").strip()
        if not base_url:
            raise OutfitterError("config", f"{ENV_URL} is not set (Outfitter's link origin)")
        if not api_key:
            raise OutfitterError("config", f"{ENV_KEY} is not set (an Outfitter A2A key)")
        _check_origin(base_url)
        return cls(base_url=base_url, api_key=api_key)


def _check_origin(url: str) -> None:
    parts = urlsplit(url)
    local = parts.hostname in ("localhost", "127.0.0.1", "::1")
    if parts.scheme != "https" and not (parts.scheme == "http" and local):
        raise OutfitterError("config", f"{ENV_URL} must be an https:// origin")
    if not parts.hostname:
        raise OutfitterError("config", f"{ENV_URL} has no host")


def _origin(url: str) -> tuple[str, str, int | None]:
    parts = urlsplit(url)
    port = parts.port or {"https": 443, "http": 80}.get(parts.scheme)
    return parts.scheme, (parts.hostname or "").lower(), port


# --- Mapping a2a-sdk results and errors -----------------------------------------------------------


def _state_name(state: int) -> str:
    return _STATE_NAMES.get(state, "unknown")


def _text_of(parts: Any) -> str:
    return "\n".join(p.text for p in parts if p.WhichOneof("content") == "text").strip()


def _task_summary(task: Task) -> dict[str, Any]:
    out: dict[str, Any] = {
        "task_id": task.id,
        "context_id": task.context_id,
        "state": _state_name(task.status.state),
        "status_text": _text_of(task.status.message.parts) if task.status.HasField("message") else "",
    }
    result = _result_of(task)
    if result is not None:
        out["result"] = result
    return out


def _result_of(task: Task) -> dict[str, Any] | None:
    """The result artifact: a text part (the final assistant message) plus a data part
    ``{branch, head, compareUrl, prUrl?}``. Parts are merged across artifacts, last one wins."""
    if not task.artifacts:
        return None
    texts: list[str] = []
    data: dict[str, Any] = {}
    for artifact in task.artifacts:
        for part in artifact.parts:
            kind = part.WhichOneof("content")
            if kind == "text" and part.text.strip():
                texts.append(part.text.strip())
            elif kind == "data":
                value = json_format.MessageToDict(part.data)
                if isinstance(value, dict):
                    data.update(value)
    result: dict[str, Any] = {
        "summary": "\n\n".join(texts),
        "branch": data.get("branch"),
        "head": data.get("head"),
        "compare_url": data.get("compareUrl"),
    }
    if data.get("prUrl"):
        result["pr_url"] = data["prUrl"]
    return result


def _http_status(exc: BaseException) -> int | None:
    seen = exc
    while seen is not None:
        if isinstance(seen, httpx.HTTPStatusError):
            return seen.response.status_code
        status = getattr(seen, "status_code", None)
        if isinstance(status, int):
            return status
        seen = seen.__cause__
    return None


def _map_error(exc: BaseException, *, starting: bool) -> OutfitterError:
    if isinstance(exc, OutfitterError):
        return exc
    if isinstance(exc, (A2AClientTimeoutError, TimeoutError, httpx.TimeoutException)):
        msg = "Outfitter did not answer in time."
        if starting:
            msg += (" The task may have been created anyway: ask the user to check Outfitter"
                    " before starting it again.")
        return OutfitterError("timeout", msg)
    if isinstance(exc, TaskNotFoundError):
        return OutfitterError("not_found", "Outfitter has no such task for this key.")
    if isinstance(exc, (InvalidParamsError, InvalidRequestError, ContentTypeNotSupportedError,
                        UnsupportedOperationError)):
        return OutfitterError("invalid", f"Outfitter refused the request: {exc.message}")
    status = _http_status(exc)
    if status in (401, 403):
        return OutfitterError(
            "auth",
            f"Outfitter refused the A2A key (HTTP {status}). It may be missing, revoked or"
            " expired (A2A keys last 90 days); the owner issues a new one and replaces the"
            f" {ENV_KEY} secret.")
    if status == 429:
        return OutfitterError("rate_limited", "Outfitter is rate-limiting this key; try later.")
    if status is not None and status >= 500:
        return OutfitterError("unavailable", f"Outfitter returned HTTP {status}; try later.")
    if isinstance(exc, AgentCardResolutionError):
        kind = "config" if status == 404 else "unavailable"
        return OutfitterError(kind, f"Could not read Outfitter's Agent Card: {exc}")
    if isinstance(exc, A2AError) and not isinstance(exc, A2AClientError):
        return OutfitterError("protocol", f"Outfitter returned an error: {exc.message}")
    if isinstance(exc, A2AClientError):
        cause = exc.__cause__
        if isinstance(cause, httpx.RequestError):
            return OutfitterError("unavailable", f"Could not reach Outfitter: {type(cause).__name__}")
        return OutfitterError("protocol", f"Unexpected reply from Outfitter: {exc}")
    if isinstance(exc, httpx.RequestError):
        return OutfitterError("unavailable", f"Could not reach Outfitter: {type(exc).__name__}")
    return OutfitterError("protocol", f"Unexpected failure: {type(exc).__name__}: {exc}")


# --- The A2A calls -------------------------------------------------------------------------------


class _Session:
    """One a2a-sdk client for one tool call: the public card, checked, then JSON-RPC calls with
    the key. A fresh client per call, since tool calls are rare and sandboxes come and go."""

    def __init__(self, config: OutfitterConfig) -> None:
        self._config = config
        self._http = httpx.AsyncClient(
            headers={"Authorization": f"Bearer {config.api_key}"},
            timeout=config.timeout,
            follow_redirects=False,
        )
        self.client: Any = None

    async def __aenter__(self) -> _Session:
        try:
            resolver = A2ACardResolver(self._http, self._config.base_url)
            card = await resolver.get_agent_card()
            self._check_card(card)
            factory = ClientFactory(ClientConfig(streaming=False, httpx_client=self._http))
            self.client = factory.create(card)
        except BaseException:
            await self._http.aclose()
            raise
        return self

    async def __aexit__(self, *exc: object) -> None:
        if self.client is not None:
            await self.client.close()  # closes self._http too
        else:
            await self._http.aclose()

    def _check_card(self, card: AgentCard) -> None:
        # The key goes wherever the card's interface says. Only ever send it to the origin we
        # were configured with, so a wrong or tampered card can't collect it.
        want = _origin(self._config.base_url)
        jsonrpc = [i for i in card.supported_interfaces if i.protocol_binding == "JSONRPC"]
        if not jsonrpc:
            raise OutfitterError("protocol", "Outfitter's Agent Card offers no JSON-RPC interface")
        for interface in jsonrpc:
            if _origin(interface.url) != want:
                raise OutfitterError(
                    "config",
                    f"Outfitter's Agent Card points at {urlsplit(interface.url).netloc or '?'},"
                    f" not the configured {urlsplit(self._config.base_url).netloc}; refusing to"
                    " send the key there")
        if not any(i.protocol_version == "1.0" for i in jsonrpc):
            raise OutfitterError("protocol", "Outfitter's Agent Card offers no A2A 1.0 interface")


def _context(extensions: bool) -> ClientCallContext:
    params = ServiceParametersFactory.create([with_a2a_extensions([EXTENSION_URI])]) if extensions else None
    return ClientCallContext(service_parameters=params)


async def start_task(
    task: str,
    skill: str | None = None,
    repo: str | None = None,
    base_branch: str | None = None,
    *,
    config: OutfitterConfig | None = None,
) -> dict[str, Any]:
    """Send ``task`` to Outfitter and return its first state. Raises ``OutfitterError``."""
    task = (task or "").strip()
    if not task:
        raise OutfitterError("invalid", "task is empty")
    if len(task) > MAX_TASK_CHARS:
        raise OutfitterError("invalid", f"task is longer than {MAX_TASK_CHARS} characters")
    if repo is not None and not _REPO_RE.match(repo):
        raise OutfitterError("invalid", "repo must look like owner/name")
    params = {k: v for k, v in (("skill", skill), ("repo", repo), ("baseBranch", base_branch)) if v}
    config = config or OutfitterConfig.from_env()

    message = Message(message_id=str(uuid.uuid4()), role=Role.ROLE_USER, parts=[Part(text=task)])
    if params:
        metadata = Struct()
        metadata.update({EXTENSION_URI: params})
        message.metadata.CopyFrom(metadata)
        message.extensions.append(EXTENSION_URI)
    request = SendMessageRequest(message=message)
    request.configuration.return_immediately = True
    request.configuration.history_length = 0

    async def call() -> dict[str, Any]:
        async with _Session(config) as session:
            async for event in session.client.send_message(request, context=_context(bool(params))):
                if event.HasField("task"):
                    return _task_summary(event.task)
                if event.HasField("message"):
                    text = _text_of(event.message.parts)
                    raise OutfitterError("protocol", f"Outfitter answered without a task: {text[:200]}")
            raise OutfitterError("protocol", "Outfitter sent an empty reply")

    try:
        async with asyncio.timeout(config.deadline_seconds):
            return await call()
    except BaseException as exc:  # noqa: BLE001 - every failure becomes a typed OutfitterError
        if isinstance(exc, (KeyboardInterrupt, SystemExit, asyncio.CancelledError)):
            raise
        raise _map_error(exc, starting=True) from exc


async def get_status(task_id: str, *, config: OutfitterConfig | None = None) -> dict[str, Any]:
    """Read task ``task_id`` back from Outfitter. Raises ``OutfitterError``."""
    task_id = (task_id or "").strip()
    if not _ID_RE.match(task_id):
        raise OutfitterError("invalid", "task_id is not a task id returned by outfitter_start")
    config = config or OutfitterConfig.from_env()

    async def call() -> dict[str, Any]:
        async with _Session(config) as session:
            task = await session.client.get_task(GetTaskRequest(id=task_id, history_length=0), context=_context(False))
            return _task_summary(task)

    try:
        async with asyncio.timeout(config.deadline_seconds):
            return await call()
    except BaseException as exc:  # noqa: BLE001
        if isinstance(exc, (KeyboardInterrupt, SystemExit, asyncio.CancelledError)):
            raise
        raise _map_error(exc, starting=False) from exc


# --- Plain, synchronous entry points (what the tools call) ---------------------------------------


def _run(coro: Any) -> Any:
    """Run a coroutine to completion from sync code, also when a loop is already running in this
    thread (then on a private loop in a worker thread)."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def outfitter_start(
    task: str,
    skill: str | None = None,
    repo: str | None = None,
    base_branch: str | None = None,
    *,
    config: OutfitterConfig | None = None,
) -> dict[str, Any]:
    """Start an Outfitter coding task. Returns ``{task_id, context_id, state, status_text}``, or
    ``{"error": {kind, message}}``."""
    try:
        return _run(start_task(task, skill, repo, base_branch, config=config))
    except OutfitterError as exc:
        return exc.to_dict()


def outfitter_status(task_id: str, *, config: OutfitterConfig | None = None) -> dict[str, Any]:
    """Read an Outfitter task. Returns ``{task_id, context_id, state, status_text, result?}``, or
    ``{"error": {kind, message}}``."""
    try:
        return _run(get_status(task_id, config=config))
    except OutfitterError as exc:
        return exc.to_dict()


_plain_start = outfitter_start
_plain_status = outfitter_status


# --- Agent Engine adapter -------------------------------------------------------------------------


def register_tools(app: Any, *, timeout: int = 30) -> None:
    """Register ``outfitter_start`` and ``outfitter_status`` on an ``agent_engine_sdk_langgraph``
    ``App`` with ``@app.tool(timeout=...)``. Results are JSON strings for the model.

    Placement is ``agent.yaml``'s job: list both names under ``sandboxes.tool.tools`` so they run
    in the tool sandbox, which alone holds the key. (``is_local`` is the SDK's legacy placement
    argument; ``agentengine migrate sandboxes`` removes it.)
    """

    @app.tool(timeout=timeout)
    def outfitter_start(  # noqa: F811 - the tool shares the plain function's name on purpose
        task: str,
        skill: str | None = None,
        repo: str | None = None,
        base_branch: str | None = None,
    ) -> str:
        """Hand a coding task to Outfitter, which runs it in its own sandbox and pushes a branch.

        Returns at once with JSON {task_id, context_id, state, status_text}; the work takes
        minutes. Keep the task_id and check on it with outfitter_status. A state of "rejected"
        means Outfitter refused the task (status_text says why); do not retry it unchanged.

        Args:
            task: What to do, in full: the repository context, the change wanted, and how to
                verify it. Outfitter cannot ask follow-up questions.
            skill: Optional Outfitter tape (skill) id to run the task with; omit for the
                key's default.
            repo: Optional GitHub repository as owner/name; must be one the key allows.
            base_branch: Optional branch to start from; defaults to the repository's default.
        """
        return json.dumps(_plain_start(task, skill, repo, base_branch))

    @app.tool(timeout=timeout)
    def outfitter_status(task_id: str) -> str:  # noqa: F811
        """Check an Outfitter task started with outfitter_start.

        Returns JSON {task_id, context_id, state, status_text, result?}. state is one of
        submitted, working, input_required, completed, failed, canceled, rejected. When
        completed, result has {summary, branch, head, compare_url, pr_url?}. Tasks take
        minutes: check when the user asks, not in a tight loop.

        Args:
            task_id: The task_id that outfitter_start returned.
        """
        return json.dumps(_plain_status(task_id))
