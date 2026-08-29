"""
Gemini adapter - `streamGenerateContent` with `alt=sse`.

Gemini's shape differs from the other two in three ways that all bite at once:

  * Roles are `user` and `model`; there is no `assistant` and no `system` role. System text goes
    in the separate top-level `systemInstruction`, which is again what keeps the instruction
    section separate from user data (docs/06 section 3).
  * A tool result is a `functionResponse` part keyed by the tool **name**, not by a call id.
    That is why `Message` carries `tool_name` as well as `tool_call_id`: dropping the name here
    would make results unattributable.
  * Function-call arguments arrive whole inside one part rather than as JSON fragments, so there
    is nothing to accumulate - but the parts stream, so a call can appear in any chunk.

The key travels in the `x-goog-api-key` header rather than the `?key=` query parameter that most
examples use, because a query string is logged by every proxy between here and Google.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence
from typing import Any
from urllib.parse import quote

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

__all__ = ["GEMINI_REQUIRED_CREDENTIALS", "GeminiProvider"]

logger = get_logger("ai.provider.gemini")

GEMINI_REQUIRED_CREDENTIALS = ("GEMINI_API_KEY",)

# Overridden with AI_MODEL; check against the vendor's current catalogue before relying on it.
DEFAULT_MODEL = "gemini-2.0-flash"


class GeminiProvider(HttpProvider):
    key = "gemini"

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
        return CredentialStatus(configured=False, missing=GEMINI_REQUIRED_CREDENTIALS)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def stream(self, request: CompletionRequest) -> AsyncIterator[ProviderEvent]:
        api_key = self._secret(self._api_key)

        system, contents = _to_gemini_contents(request.messages)
        payload: dict[str, Any] = {
            "contents": contents,
            "generationConfig": {"maxOutputTokens": request.max_output_tokens},
        }
        if system:
            payload["systemInstruction"] = {"parts": [{"text": system}]}
        if request.tools:
            payload["tools"] = [
                {
                    "functionDeclarations": [
                        {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters,
                        }
                        for tool in request.tools
                    ]
                }
            ]

        headers = {
            "x-goog-api-key": api_key,
            "content-type": "application/json",
            "accept": "text/event-stream",
        }
        path = f"/v1beta/models/{quote(self.model, safe='')}:streamGenerateContent"

        calls: list[ToolCall] = []
        usage = Usage()
        stop_reason = "end_turn"
        call_ordinal = 0

        async with self._client.stream(
            "POST", path, params={"alt": "sse"}, json=payload, headers=headers
        ) as response:
            await self._raise_for_status(response)

            async for _event, data in iter_sse(response):
                if not data:
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
                    raise ProviderError("gemini stream returned an error", provider=self.key)

                if isinstance(frame.get("usageMetadata"), dict):
                    metadata = frame["usageMetadata"]
                    usage = Usage(
                        input_tokens=int(metadata.get("promptTokenCount", 0)),
                        output_tokens=int(metadata.get("candidatesTokenCount", 0)),
                    )

                for candidate in frame.get("candidates", []):
                    reason = candidate.get("finishReason")
                    if reason:
                        stop_reason = str(reason).lower()
                    for part in (candidate.get("content") or {}).get("parts", []):
                        text = part.get("text")
                        if text:
                            yield TextDelta(text=text)
                        function_call = part.get("functionCall")
                        if isinstance(function_call, dict):
                            arguments = function_call.get("args")
                            if not isinstance(arguments, dict):
                                arguments = {}
                            call_ordinal += 1
                            calls.append(
                                ToolCall(
                                    # Gemini does not issue call ids. One is synthesised so the
                                    # gateway's own bookkeeping - and the conversation record on
                                    # the API side - can still pair a result with its call.
                                    id=f"gemini-call-{call_ordinal}",
                                    name=str(function_call.get("name", "")),
                                    arguments=arguments,
                                    raw_arguments=json.dumps(arguments, ensure_ascii=False),
                                )
                            )

        if calls:
            stop_reason = "tool_use"
            yield ToolCallsRequested(calls=tuple(calls))
        yield TurnComplete(stop_reason=stop_reason, usage=usage)


def _to_gemini_contents(messages: Sequence[Message]) -> tuple[str, list[dict[str, Any]]]:
    system_parts: list[str] = []
    contents: list[dict[str, Any]] = []

    for message in messages:
        if message.role == "system":
            system_parts.append(message.content)
            continue

        if message.role == "tool":
            part = {
                "functionResponse": {
                    "name": message.tool_name or "",
                    # The response must be an object; the tool's JSON is nested under a key
                    # rather than spread, so a tool that returns a list still round-trips.
                    "response": {"result": message.content},
                }
            }
            if contents and contents[-1]["role"] == "user":
                contents[-1]["parts"].append(part)
            else:
                contents.append({"role": "user", "parts": [part]})
            continue

        parts: list[dict[str, Any]] = []
        if message.content:
            parts.append({"text": message.content})
        for call in message.tool_calls:
            parts.append({"functionCall": {"name": call.name, "args": call.arguments}})
        if parts:
            contents.append(
                {"role": "model" if message.role == "assistant" else "user", "parts": parts}
            )

    return "\n\n".join(part for part in system_parts if part), contents
