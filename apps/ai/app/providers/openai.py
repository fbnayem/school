"""
OpenAI adapter - Chat Completions, streaming.

Two framing details that differ from Anthropic and cause silent breakage if assumed away:

  * The stream is terminated by a literal `data: [DONE]` sentinel, which is not JSON. Parsing it
    as JSON throws on the last frame of every successful request.
  * Tool calls stream as *fragments indexed by position*: the first delta for an index carries
    the id and the function name, and later deltas carry slices of `function.arguments` that are
    only valid JSON once concatenated. Accumulating by `index` rather than by `id` is required,
    because the later fragments have no id.

`OPENAI_BASE_URL` exists so the adapter also drives an OpenAI-compatible local server, which is
the honest way to run this without sending a school's records to a third party.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence
from typing import Any

import httpx
from pydantic import SecretStr

from ..errors import ProviderError
from ..logs import get_logger
from ._base_http import HttpProvider
from ._sse import iter_sse
from .base import (
    CompletionRequest,
    CredentialStatus,
    Message,
    ProviderEvent,
    TextDelta,
    ToolCall,
    ToolCallsRequested,
    TurnComplete,
    Usage,
)

__all__ = ["OPENAI_REQUIRED_CREDENTIALS", "OpenAIProvider"]

logger = get_logger("ai.provider.openai")

OPENAI_REQUIRED_CREDENTIALS = ("OPENAI_API_KEY",)

# Overridden with AI_MODEL. Model catalogues move; the README says to check this against the
# vendor's current list rather than trusting a default that was right once.
DEFAULT_MODEL = "gpt-4o-mini"

_DONE = "[DONE]"


class OpenAIProvider(HttpProvider):
    key = "openai"

    def __init__(
        self,
        *,
        client: httpx.AsyncClient,
        api_key: SecretStr | None,
        model: str | None = None,
    ) -> None:
        self._client = client
        self._api_key = api_key
        self.model = model or DEFAULT_MODEL

    def credential_status(self) -> CredentialStatus:
        if self._api_key and self._api_key.get_secret_value():
            return CredentialStatus(configured=True)
        return CredentialStatus(configured=False, missing=OPENAI_REQUIRED_CREDENTIALS)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def stream(self, request: CompletionRequest) -> AsyncIterator[ProviderEvent]:
        api_key = self._secret(self._api_key)

        payload: dict[str, Any] = {
            "model": self.model,
            "max_completion_tokens": request.max_output_tokens,
            "stream": True,
            # Without this the final frame carries no usage and the exchange is persisted with
            # a zero cost, which makes the per-tenant budget in docs/06 section 8 unenforceable.
            "stream_options": {"include_usage": True},
            "messages": _to_openai_messages(request.messages),
        }
        if request.tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    },
                }
                for tool in request.tools
            ]

        headers = {
            "authorization": f"Bearer {api_key}",
            "content-type": "application/json",
            "accept": "text/event-stream",
        }

        pending: dict[int, dict[str, Any]] = {}
        usage = Usage()
        stop_reason = "end_turn"

        async with self._client.stream(
            "POST", "/chat/completions", json=payload, headers=headers
        ) as response:
            await self._raise_for_status(response)

            async for _event, data in iter_sse(response):
                if not data or data.strip() == _DONE:
                    continue
                try:
                    frame = json.loads(data)
                except json.JSONDecodeError:
                    logger.warning(
                        "discarded malformed provider frame", extra={"provider": self.key}
                    )
                    continue

                if isinstance(frame.get("error"), dict):
                    logger.error(
                        "provider stream error",
                        extra={"provider": self.key, "detail": frame["error"]},
                    )
                    raise ProviderError("openai stream returned an error", provider=self.key)

                if isinstance(frame.get("usage"), dict):
                    usage = Usage(
                        input_tokens=int(frame["usage"].get("prompt_tokens", 0)),
                        output_tokens=int(frame["usage"].get("completion_tokens", 0)),
                    )

                for choice in frame.get("choices", []):
                    delta = choice.get("delta") or {}
                    text = delta.get("content")
                    if text:
                        yield TextDelta(text=text)
                    for fragment in delta.get("tool_calls") or []:
                        _accumulate(pending, fragment)
                    finish = choice.get("finish_reason")
                    if finish:
                        stop_reason = "tool_use" if finish == "tool_calls" else finish

        calls = tuple(_finish_call(slot) for _, slot in sorted(pending.items()))
        if calls:
            yield ToolCallsRequested(calls=calls)
        yield TurnComplete(stop_reason=stop_reason, usage=usage)


def _accumulate(pending: dict[int, dict[str, Any]], fragment: dict[str, Any]) -> None:
    index = int(fragment.get("index", 0))
    slot = pending.setdefault(index, {"id": "", "name": "", "arguments": []})
    if fragment.get("id"):
        slot["id"] = fragment["id"]
    function = fragment.get("function") or {}
    if function.get("name"):
        slot["name"] = function["name"]
    if function.get("arguments"):
        slot["arguments"].append(function["arguments"])


def _finish_call(slot: dict[str, Any]) -> ToolCall:
    raw = "".join(slot["arguments"])
    try:
        arguments = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        arguments = {}
    if not isinstance(arguments, dict):
        arguments = {}
    return ToolCall(id=slot["id"], name=slot["name"], arguments=arguments, raw_arguments=raw)


def _to_openai_messages(messages: Sequence[Message]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for message in messages:
        if message.role == "tool":
            out.append(
                {
                    "role": "tool",
                    "tool_call_id": message.tool_call_id or "",
                    "content": message.content,
                }
            )
            continue

        if message.role == "assistant" and message.tool_calls:
            out.append(
                {
                    "role": "assistant",
                    "content": message.content or None,
                    "tool_calls": [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": call.raw_arguments
                                or json.dumps(call.arguments, ensure_ascii=False),
                            },
                        }
                        for call in message.tool_calls
                    ],
                }
            )
            continue

        out.append({"role": message.role, "content": message.content})
    return out
