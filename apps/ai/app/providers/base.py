"""
The provider interface.

Mirrors the TypeScript `AIProvider` in docs/06 §4: adapters for OpenAI, Anthropic, Gemini and a
local/mock model, with no application logic referencing a vendor. A provider change is
configuration.

One shape decision worth explaining. Every adapter is a **streaming** adapter that yields
`ProviderEvent`s, even though a non-streaming `complete()` would be less code. Streaming is not
a nicety here: the gateway holds an HTTP connection open for the caller, and buffering the whole
completion before the first byte would turn a 20-second answer into a 20-second blank screen and
a proxy timeout. Making the streaming form the only form also removes the temptation to
"simulate" streaming by chunking a finished string, which looks identical to a user and is a lie
about where the latency is.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

__all__ = [
    "AIProvider",
    "CompletionRequest",
    "CredentialStatus",
    "Message",
    "ProviderEvent",
    "Role",
    "TextDelta",
    "ToolCall",
    "ToolCallsRequested",
    "ToolSpec",
    "TurnComplete",
    "Usage",
]

Role = Literal["system", "user", "assistant", "tool"]


@dataclass(frozen=True, slots=True)
class ToolSpec:
    """One entry of the manifest `apps/api` returned for this specific caller."""

    name: str
    description: str
    parameters: dict[str, Any]


@dataclass(frozen=True, slots=True)
class ToolCall:
    """A tool the model asked for. `arguments` is parsed JSON; `raw_arguments` is what it sent."""

    id: str
    name: str
    arguments: dict[str, Any]
    raw_arguments: str = ""


@dataclass(frozen=True, slots=True)
class Message:
    role: Role
    content: str = ""
    #: Set on an assistant turn that requested tools.
    tool_calls: tuple[ToolCall, ...] = ()
    #: Set on a `tool` message, linking the result back to the call.
    tool_call_id: str | None = None
    #: Set on a `tool` message so adapters that key results by name (Gemini) can do so.
    tool_name: str | None = None


@dataclass(frozen=True, slots=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0


@dataclass(frozen=True, slots=True)
class TextDelta:
    """A fragment of the assistant's visible answer."""

    text: str


@dataclass(frozen=True, slots=True)
class ToolCallsRequested:
    """The turn ended asking for tools. Emitted once, after the whole turn is parsed."""

    calls: tuple[ToolCall, ...]


@dataclass(frozen=True, slots=True)
class TurnComplete:
    """The turn ended. Always emitted last, exactly once, whatever the outcome."""

    stop_reason: str
    usage: Usage = field(default_factory=Usage)


ProviderEvent = TextDelta | ToolCallsRequested | TurnComplete


@dataclass(frozen=True, slots=True)
class CompletionRequest:
    messages: Sequence[Message]
    tools: Sequence[ToolSpec] = ()
    max_output_tokens: int = 4096


@dataclass(frozen=True, slots=True)
class CredentialStatus:
    """
    Whether an adapter can run, and what is missing if it cannot.

    `missing` holds variable names. It is safe to log and must never be serialised into a
    client-facing response (docs/07 §6).
    """

    configured: bool
    missing: tuple[str, ...] = ()


@runtime_checkable
class AIProvider(Protocol):
    """What every adapter implements. Nothing outside `app/providers` knows more than this."""

    key: str
    model: str

    def credential_status(self) -> CredentialStatus: ...

    def stream(self, request: CompletionRequest) -> AsyncIterator[ProviderEvent]: ...

    async def aclose(self) -> None: ...
