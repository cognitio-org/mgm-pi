"""The agent's LLM: an OpenAI-compatible model through Kernal's LiteLLM gateway."""

from __future__ import annotations

import os

from langchain_core.language_models import BaseChatModel
from langchain_openai import ChatOpenAI
from openai import DefaultAsyncHttpxClient, DefaultHttpxClient
from pydantic import SecretStr

# Must match the agent sandbox's egress in agent.yaml.
BASE_URL = "https://router.kernal.one/v1"
MODEL = "gpt-5-nano"


def build_llm() -> BaseChatModel:
    api_key = os.environ.get("LLM_API_KEY", "")
    if not api_key:
        raise RuntimeError("LLM_API_KEY is missing; set it in .env or as an Agent Engine secret")

    # Set the key at send time, as the agentengine templates do, so traces never serialise it.
    def inject(request) -> None:
        request.headers["authorization"] = "Bearer " + api_key

    async def inject_async(request) -> None:
        inject(request)

    return ChatOpenAI(
        model=MODEL,
        api_key=SecretStr("unused"),
        base_url=BASE_URL,
        use_responses_api=False,
        http_client=DefaultHttpxClient(event_hooks={"request": [inject]}, follow_redirects=False),
        http_async_client=DefaultAsyncHttpxClient(
            event_hooks={"request": [inject_async]}, follow_redirects=False),
    )
