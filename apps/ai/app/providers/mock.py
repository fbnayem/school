"""
The mock provider.

Requires no credentials and is fully deterministic: the same conversation always produces the
same tokens, in the same order. That is what makes it usable in the test suite and in a
developer's `docker compose up` with nothing configured, which is the whole point — docs/09's
rule that a missing provider must never block a module applies here too.

It is not a pretend model. Every answer is prefixed `[mock provider]`, and `AI_PROVIDER=mock` is
refused outright when `AI_ENVIRONMENT=production` (see `config.py`), because a plausible
invented sentence about a child's attendance is worse than no answer at all.

Behaviour, in full:

  * If the caller's message mentions a tool the caller is actually allowed to use, and that
    tool has not been called yet in this exchange, it asks for that tool. This exercises the
    real delegated-callback path end to end without a network.
  * Otherwise it answers from the tool results it has, naming each tool it consulted, and says
    plainly when it consulted none.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import AsyncIterator, Sequence

from .base import (
    CompletionRequest,
    CredentialStatus,
    Message,
    ProviderEvent,
    TextDelta,
    ToolCall,
    ToolCallsRequested,
    ToolSpec,
    TurnComplete,
    Usage,
)

__all__ = ["MockProvider"]

# Roughly four characters per token. Used only so the usage figures the gateway reports are a
# consistent function of the text rather than a constant — never presented as a billing number.
_CHARS_PER_TOKEN = 4


class MockProvider:
    key = "mock"

    def __init__(self, model: str | None = None) -> None:
        self.model = model or "shikkha-mock-1"

    def credential_status(self) -> CredentialStatus:
        # The one adapter that is always configured. Its whole reason to exist.
        return CredentialStatus(configured=True)

    async def aclose(self) -> None:
        return None

    async def stream(self, request: CompletionRequest) -> AsyncIterator[ProviderEvent]:
        wanted = self._tool_to_call(request.messages, request.tools)
        if wanted is not None:
            call = ToolCall(
                # Deterministic id: derived from the tool name and the turn number, so a replay
                # of the same conversation produces byte-identical events.
                id=f"mock-call-{self._turn_number(request.messages)}-{wanted.name}",
                name=wanted.name,
                arguments={},
                raw_arguments="{}",
            )
            yield ToolCallsRequested(calls=(call,))
            yield TurnComplete(
                stop_reason="tool_use",
                usage=self._usage(request.messages, ""),
            )
            return

        answer = self._answer(request.messages)
        # Emitted in fragments so the SSE path is exercised as a stream rather than as one blob.
        for chunk in _chunks(answer):
            yield TextDelta(text=chunk)
        yield TurnComplete(stop_reason="end_turn", usage=self._usage(request.messages, answer))

    # -- internals ---------------------------------------------------------------------

    def _tool_to_call(
        self, messages: Sequence[Message], tools: Sequence[ToolSpec]
    ) -> ToolSpec | None:
        already_called = {message.tool_name for message in messages if message.role == "tool"}
        haystack = " ".join(m.content for m in messages if m.role == "user").lower()
        for tool in tools:
            if tool.name in already_called:
                continue
            # Match on the full name (`attendance.summary`) or on either half, so a question
            # phrased "what is the attendance summary for..." reaches the tool.
            needles = {tool.name, *tool.name.split(".")}
            if any(needle in haystack for needle in needles if len(needle) > 3):
                return tool
        return None

    def _turn_number(self, messages: Sequence[Message]) -> int:
        return sum(1 for message in messages if message.role == "assistant")

    def _answer(self, messages: Sequence[Message]) -> str:
        consulted = [m.tool_name for m in messages if m.role == "tool" and m.tool_name]
        question = next(
            (m.content for m in reversed(messages) if m.role == "user"),
            "",
        )
        digest = hashlib.sha256(question.encode("utf-8")).hexdigest()[:8]

        if consulted:
            sources = ", ".join(dict.fromkeys(consulted))
            body = (
                f"I answered from {len(consulted)} tool result(s): {sources}. "
                "The figures above come from those results and from nothing else."
            )
        else:
            body = (
                "I did not call any tool, so this answer is not grounded in your school's "
                "records. Ask again naming what you need — a student, a class, a date range — "
                "and I will look it up through a tool you are allowed to use."
            )

        return f"[mock provider {digest}] {body}"

    def _usage(self, messages: Sequence[Message], answer: str) -> Usage:
        serialised = json.dumps([(m.role, m.content) for m in messages], ensure_ascii=False)
        return Usage(
            input_tokens=len(serialised) // _CHARS_PER_TOKEN,
            output_tokens=len(answer) // _CHARS_PER_TOKEN,
        )


def _chunks(text: str, size: int = 24) -> list[str]:
    return [text[index : index + size] for index in range(0, len(text), size)] or [""]
