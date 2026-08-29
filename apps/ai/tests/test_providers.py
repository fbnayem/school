"""
The provider adapters.

Each vendor's streaming format is driven from canned bytes through `httpx.MockTransport`, so the
parsing is tested rather than mocked away. The framing edge cases here are the ones that produce
*plausible but wrong* output when they are got wrong - a truncated tool argument, a dropped
citation, a stray `[DONE]` parsed as JSON - which is exactly the class of bug that survives a
casual review.

The mock provider is tested for determinism, because a non-deterministic mock makes every other
test in this suite flaky in a way that looks like a real failure.
"""

from __future__ import annotations

import json
from collections.abc import Callable

import httpx
import pytest
from pydantic import SecretStr

from app.config import Settings
from app.errors import ProviderCredentialsMissing, ProviderError
from app.providers.anthropic import AnthropicProvider
from app.providers.base import (
    AIProvider,
    CompletionRequest,
    Message,
    ProviderEvent,
    ToolCallsRequested,
    ToolSpec,
    TurnComplete,
)
from app.providers.gemini import GeminiProvider
from app.providers.mock import MockProvider
from app.providers.openai import OpenAIProvider
from app.providers.registry import build_provider

FAKE_KEY = SecretStr("sk-test-DO-NOT-LEAK-9f3a2b1c8d7e6f5a")

TOOLS = (
    ToolSpec(
        name="attendance.summary",
        description="Attendance percentages.",
        parameters={"type": "object", "properties": {"studentId": {"type": "string"}}},
    ),
)


def _request(messages: list[Message] | None = None) -> CompletionRequest:
    return CompletionRequest(
        messages=messages
        or [Message(role="system", content="rules"), Message(role="user", content="hello")],
        tools=TOOLS,
        max_output_tokens=256,
    )


def _tool_calls(events: list[ProviderEvent]) -> list[ToolCallsRequested]:
    return [event for event in events if isinstance(event, ToolCallsRequested)]


def _final(events: list[ProviderEvent]) -> TurnComplete:
    """The last event is always a TurnComplete - that is part of the provider contract."""
    last = events[-1]
    assert isinstance(last, TurnComplete)
    return last


def _stream_transport(body: str, captured: list[httpx.Request]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200, content=body.encode("utf-8"), headers={"content-type": "text/event-stream"}
        )

    return httpx.MockTransport(handler)


# -- mock ----------------------------------------------------------------------------------


async def test_the_mock_provider_is_deterministic() -> None:
    provider = MockProvider()

    first = [event async for event in provider.stream(_request())]
    second = [event async for event in provider.stream(_request())]

    assert first == second


async def test_the_mock_provider_labels_itself_in_every_answer() -> None:
    """Nobody may mistake a mock answer for a record. Production refuses `mock` outright."""
    provider = MockProvider()

    events = [event async for event in provider.stream(_request())]
    text = "".join(getattr(event, "text", "") for event in events)

    assert text.startswith("[mock provider")
    assert "did not call any tool" in text


async def test_the_mock_provider_needs_no_credentials() -> None:
    assert MockProvider().credential_status().configured is True


# -- credential refusal --------------------------------------------------------------------


@pytest.mark.parametrize(
    ("factory", "variable"),
    [
        (
            lambda client: OpenAIProvider(client=client, api_key=None),
            "OPENAI_API_KEY",
        ),
        (
            lambda client: AnthropicProvider(client=client, api_key=None, api_version="2023-06-01"),
            "ANTHROPIC_API_KEY",
        ),
        (
            lambda client: GeminiProvider(client=client, api_key=None),
            "GEMINI_API_KEY",
        ),
    ],
)
async def test_a_provider_without_credentials_refuses_loudly(
    factory: Callable[[httpx.AsyncClient], AIProvider], variable: str
) -> None:
    """
    Named in the context - which goes to the log - and never in the public message.

    This is the `stub-gps.provider.ts` pattern: refuse, name the variable where an operator will
    see it, and never fabricate a success.
    """
    calls: list[httpx.Request] = []
    provider = factory(httpx.AsyncClient(transport=_stream_transport("", calls)))

    status = provider.credential_status()
    assert status.configured is False
    assert status.missing == (variable,)

    with pytest.raises(ProviderCredentialsMissing) as raised:
        [event async for event in provider.stream(_request())]

    assert raised.value.context["missingCredential"] == variable
    assert variable not in raised.value.public_message()
    assert calls == [], "a request was sent without credentials"
    await provider.aclose()


# -- anthropic -----------------------------------------------------------------------------

ANTHROPIC_STREAM = """\
event: message_start
data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":412}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Checking "}}

event: ping
data: {"type":"ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"attendance."}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"attendance.summary","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"studentId\\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" \\"stu-7\\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":38}}

event: message_stop
data: {"type":"message_stop"}

"""


async def test_anthropic_parses_text_and_a_fragmented_tool_call() -> None:
    calls: list[httpx.Request] = []
    provider = AnthropicProvider(
        client=httpx.AsyncClient(
            base_url="https://api.anthropic.test",
            transport=_stream_transport(ANTHROPIC_STREAM, calls),
        ),
        api_key=FAKE_KEY,
        api_version="2023-06-01",
    )

    events = [event async for event in provider.stream(_request())]
    await provider.aclose()

    text = "".join(getattr(event, "text", "") for event in events)
    assert text == "Checking attendance."

    tool_events = _tool_calls(events)
    assert len(tool_events) == 1
    call = tool_events[0].calls[0]
    assert call.name == "attendance.summary"
    # Only correct if the fragments were concatenated before parsing.
    assert call.arguments == {"studentId": "stu-7"}

    final = _final(events)
    assert final.stop_reason == "tool_use"
    assert final.usage.input_tokens == 412
    assert final.usage.output_tokens == 38


async def test_anthropic_puts_instructions_in_system_and_never_in_a_user_turn() -> None:
    calls: list[httpx.Request] = []
    provider = AnthropicProvider(
        client=httpx.AsyncClient(
            base_url="https://api.anthropic.test",
            transport=_stream_transport(ANTHROPIC_STREAM, calls),
        ),
        api_key=FAKE_KEY,
        api_version="2023-06-01",
    )

    [event async for event in provider.stream(_request())]
    await provider.aclose()

    body = json.loads(calls[0].read())
    assert body["system"] == "rules"
    assert all(turn["role"] != "system" for turn in body["messages"])
    # Sampling parameters are rejected by the current models.
    assert "temperature" not in body
    assert calls[0].headers["x-api-key"] == FAKE_KEY.get_secret_value()


async def test_anthropic_merges_parallel_tool_results_into_one_user_turn() -> None:
    """Splitting them trains the model to stop calling tools in parallel."""
    calls: list[httpx.Request] = []
    provider = AnthropicProvider(
        client=httpx.AsyncClient(
            base_url="https://api.anthropic.test",
            transport=_stream_transport(ANTHROPIC_STREAM, calls),
        ),
        api_key=FAKE_KEY,
        api_version="2023-06-01",
    )

    messages = [
        Message(role="user", content="q"),
        Message(role="tool", content="a", tool_call_id="t1", tool_name="attendance.summary"),
        Message(role="tool", content="b", tool_call_id="t2", tool_name="knowledge.search"),
    ]
    [event async for event in provider.stream(_request(messages))]
    await provider.aclose()

    body = json.loads(calls[0].read())
    tool_turns = [turn for turn in body["messages"] if turn["content"][0]["type"] == "tool_result"]
    assert len(tool_turns) == 1
    assert len(tool_turns[0]["content"]) == 2


async def test_anthropic_surfaces_an_error_frame_without_leaking_it() -> None:
    stream = 'event: error\ndata: {"type":"error","error":{"message":"overloaded: node-7"}}\n\n'
    calls: list[httpx.Request] = []
    provider = AnthropicProvider(
        client=httpx.AsyncClient(
            base_url="https://api.anthropic.test", transport=_stream_transport(stream, calls)
        ),
        api_key=FAKE_KEY,
        api_version="2023-06-01",
    )

    with pytest.raises(ProviderError) as raised:
        [event async for event in provider.stream(_request())]
    await provider.aclose()

    assert "node-7" not in raised.value.public_message()


# -- openai --------------------------------------------------------------------------------

OPENAI_STREAM = """\
data: {"choices":[{"delta":{"content":"Checking "},"index":0}]}

data: {"choices":[{"delta":{"content":"attendance."},"index":0}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"attendance.summary","arguments":"{\\"studentId\\""}}]},"index":0}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"stu-7\\"}"}}]},"index":0,"finish_reason":"tool_calls"}]}

data: {"choices":[],"usage":{"prompt_tokens":412,"completion_tokens":38}}

data: [DONE]

"""


async def test_openai_parses_indexed_tool_call_fragments_and_the_done_sentinel() -> None:
    calls: list[httpx.Request] = []
    provider = OpenAIProvider(
        client=httpx.AsyncClient(
            base_url="https://api.openai.test/v1",
            transport=_stream_transport(OPENAI_STREAM, calls),
        ),
        api_key=FAKE_KEY,
    )

    events = [event async for event in provider.stream(_request())]
    await provider.aclose()

    assert "".join(getattr(event, "text", "") for event in events) == "Checking attendance."

    tool_events = _tool_calls(events)
    call = tool_events[0].calls[0]
    assert call.id == "call_1"
    # The later fragment carries no id and no name; accumulating by index is what makes this work.
    assert call.name == "attendance.summary"
    assert call.arguments == {"studentId": "stu-7"}

    final = _final(events)
    assert final.stop_reason == "tool_use"
    assert final.usage.input_tokens == 412
    assert calls[0].headers["authorization"] == f"Bearer {FAKE_KEY.get_secret_value()}"


async def test_openai_asks_for_usage_so_the_exchange_can_be_costed() -> None:
    calls: list[httpx.Request] = []
    provider = OpenAIProvider(
        client=httpx.AsyncClient(
            base_url="https://api.openai.test/v1",
            transport=_stream_transport(OPENAI_STREAM, calls),
        ),
        api_key=FAKE_KEY,
    )

    [event async for event in provider.stream(_request())]
    await provider.aclose()

    body = json.loads(calls[0].read())
    assert body["stream_options"] == {"include_usage": True}


# -- gemini --------------------------------------------------------------------------------

GEMINI_STREAM = """\
data: {"candidates":[{"content":{"parts":[{"text":"Checking "}],"role":"model"}}]}

data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"attendance.summary","args":{"studentId":"stu-7"}}}],"role":"model"}}],"usageMetadata":{"promptTokenCount":412,"candidatesTokenCount":38}}

"""


async def test_gemini_parses_a_function_call_and_keeps_the_key_out_of_the_url() -> None:
    calls: list[httpx.Request] = []
    provider = GeminiProvider(
        client=httpx.AsyncClient(
            base_url="https://gemini.test", transport=_stream_transport(GEMINI_STREAM, calls)
        ),
        api_key=FAKE_KEY,
    )

    events = [event async for event in provider.stream(_request())]
    await provider.aclose()

    tool_events = _tool_calls(events)
    assert tool_events[0].calls[0].arguments == {"studentId": "stu-7"}
    assert _final(events).usage.input_tokens == 412

    # A query string is logged by every proxy in the path; the key travels in a header.
    assert FAKE_KEY.get_secret_value() not in str(calls[0].url)
    assert calls[0].headers["x-goog-api-key"] == FAKE_KEY.get_secret_value()
    assert calls[0].url.params["alt"] == "sse"

    body = json.loads(calls[0].read())
    assert body["systemInstruction"]["parts"][0]["text"] == "rules"
    assert all(turn["role"] != "system" for turn in body["contents"])


# -- registry ------------------------------------------------------------------------------


async def test_the_registry_returns_the_configured_adapter(settings: Settings) -> None:
    assert build_provider(settings).key == "mock"

    openai = build_provider(settings.model_copy(update={"ai_provider": "openai"}))
    assert openai.key == "openai"
    await openai.aclose()


async def test_the_registry_never_falls_back_to_mock_when_a_key_is_absent(
    settings: Settings,
) -> None:
    """
    A silent fallback would give a school invented answers with no signal at all - worse than
    both the outage and the loud refusal.
    """
    provider = build_provider(settings.model_copy(update={"ai_provider": "anthropic"}))

    assert provider.key == "anthropic"
    assert provider.credential_status().configured is False
    await provider.aclose()
