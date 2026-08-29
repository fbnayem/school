"""
Anthropic adapter - the Messages API, streaming.

Notes that are easy to get wrong and expensive to rediscover:

  * `system` is a **top-level field**, not a message with `role: "system"`. A system role inside
    `messages` is rejected. That matters here because the instruction section is the security
    boundary (docs/06 section 3): instructions must land in `system`, and user text must not.
  * Tool results go back as a `user` message containing `tool_result` blocks, and **all** results
    for one assistant turn belong in a **single** user message. Splitting them across messages
    trains the model to stop making parallel calls, which quietly doubles latency.
  * `temperature` is not sent. The current Opus-family models reject sampling parameters, and a
    knob that 400s is worse than no knob.
  * Tool arguments arrive as `input_json_delta` fragments that are only valid JSON once
    concatenated, so they are buffered per content-block index and parsed at `content_block_stop`.
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

__all__ = ["ANTHROPIC_REQUIRED_CREDENTIALS", "AnthropicProvider"]

logger = get_logger("ai.provider.anthropic")

ANTHROPIC_REQUIRED_CREDENTIALS = ("ANTHROPIC_API_KEY",)

DEFAULT_MODEL = "claude-opus-5"


class AnthropicProvider(HttpProvider):
    key = "anthropic"

    def __init__(
        self,
        *,
        client: httpx.AsyncClient,
        api_key: SecretStr | None,
        api_version: str,
        model: str | None = None,
    ) -> None:
        self._client = client
        self._api_key = api_key
        self._api_version = api_version
        self.model = model or DEFAULT_MODEL

    def credential_status(self) -> CredentialStatus:
        if self._api_key and self._api_key.get_secret_value():
            return CredentialStatus(configured=True)
        return CredentialStatus(configured=False, missing=ANTHROPIC_REQUIRED_CREDENTIALS)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def stream(self, request: CompletionRequest) -> AsyncIterator[ProviderEvent]:
        api_key = self._secret(self._api_key)

        system, messages = _split_system(request.messages)
        payload: dict[str, Any] = {
            "model": self.model,
            "max_tokens": request.max_output_tokens,
            "stream": True,
            "messages": messages,
        }
        if system:
            payload["system"] = system
        if request.tools:
            payload["tools"] = [
                {
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.parameters,
                }
                for tool in request.tools
            ]

        headers = {
            "x-api-key": api_key,
            "anthropic-version": self._api_version,
            "content-type": "application/json",
            "accept": "text/event-stream",
        }

        # Per content-block index: the tool_use header plus the JSON fragments seen so far.
        pending: dict[int, dict[str, Any]] = {}
        calls: list[ToolCall] = []
        usage = Usage()
        stop_reason = "end_turn"

        async with self._client.stream(
            "POST", "/v1/messages", json=payload, headers=headers
        ) as response:
            await self._raise_for_status(response)

            async for event, data in iter_sse(response):
                if event == "ping" or not data:
                    continue
                try:
                    frame = json.loads(data)
                except json.JSONDecodeError:
                    logger.warning(
                        "discarded malformed provider frame", extra={"provider": self.key}
                    )
                    continue

                kind = event or frame.get("type")

                if kind == "error":
                    logger.error(
                        "provider stream error",
                        extra={"provider": self.key, "detail": frame.get("error", {})},
                    )
                    raise ProviderError("anthropic stream returned an error", provider=self.key)

                if kind == "message_start":
                    usage = Usage(
                        input_tokens=int(
                            frame.get("message", {}).get("usage", {}).get("input_tokens", 0)
                        ),
                        output_tokens=usage.output_tokens,
                    )
                elif kind == "content_block_start":
                    block = frame.get("content_block", {})
                    if block.get("type") == "tool_use":
                        pending[int(frame.get("index", 0))] = {
                            "id": block.get("id", ""),
                            "name": block.get("name", ""),
                            "json": [],
                        }
                elif kind == "content_block_delta":
                    delta = frame.get("delta", {})
                    delta_type = delta.get("type")
                    if delta_type == "text_delta":
                        text = delta.get("text", "")
                        if text:
                            yield TextDelta(text=text)
                    elif delta_type == "input_json_delta":
                        slot = pending.get(int(frame.get("index", 0)))
                        if slot is not None:
                            slot["json"].append(delta.get("partial_json", ""))
                elif kind == "content_block_stop":
                    finished = pending.pop(int(frame.get("index", 0)), None)
                    if finished is not None:
                        calls.append(_finish_call(finished))
                elif kind == "message_delta":
                    stop_reason = frame.get("delta", {}).get("stop_reason") or stop_reason
                    usage = Usage(
                        input_tokens=usage.input_tokens,
                        output_tokens=int(frame.get("usage", {}).get("output_tokens", 0))
                        or usage.output_tokens,
                    )

        if calls:
            yield ToolCallsRequested(calls=tuple(calls))
        yield TurnComplete(stop_reason=stop_reason, usage=usage)


def _finish_call(slot: dict[str, Any]) -> ToolCall:
    raw = "".join(slot["json"])
    try:
        arguments = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        # A malformed argument blob is passed on as empty rather than guessed at. The
        # orchestrator checks the tool against the caller's manifest regardless, and `apps/api`
        # validates the arguments again with the same Zod schema the HTTP API uses
        # (docs/06 section 3), so an invented shape cannot reach a query.
        arguments = {}
    if not isinstance(arguments, dict):
        arguments = {}
    return ToolCall(id=slot["id"], name=slot["name"], arguments=arguments, raw_arguments=raw)


def _split_system(messages: Sequence[Message]) -> tuple[str, list[dict[str, Any]]]:
    """Lift system turns to the top level and translate the rest into Anthropic blocks."""
    system_parts: list[str] = []
    out: list[dict[str, Any]] = []

    for message in messages:
        if message.role == "system":
            system_parts.append(message.content)
            continue

        if message.role == "tool":
            block = {
                "type": "tool_result",
                "tool_use_id": message.tool_call_id or "",
                "content": message.content,
            }
            if out and out[-1]["role"] == "user" and _is_tool_result_turn(out[-1]):
                out[-1]["content"].append(block)
            else:
                out.append({"role": "user", "content": [block]})
            continue

        content: list[dict[str, Any]] = []
        if message.content:
            content.append({"type": "text", "text": message.content})
        for call in message.tool_calls:
            content.append(
                {"type": "tool_use", "id": call.id, "name": call.name, "input": call.arguments}
            )
        if content:
            out.append({"role": message.role, "content": content})

    return "\n\n".join(part for part in system_parts if part), out


def _is_tool_result_turn(turn: dict[str, Any]) -> bool:
    content = turn.get("content")
    return isinstance(content, list) and all(
        isinstance(block, dict) and block.get("type") == "tool_result" for block in content
    )
