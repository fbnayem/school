"""
`POST /chat`, end to end, with `apps/api` and the provider both mocked.

What is being asserted here is the gateway's behaviour as a whole: that the manifest is fetched
with the caller's token before anything else happens, that a refusal from `apps/api` reaches the
caller unchanged, that a tool loop is bounded, and that the stream is well-formed SSE.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable
from typing import Any

import httpx

from app.providers.base import (
    CompletionRequest,
    CredentialStatus,
    ProviderEvent,
    TextDelta,
    ToolCall,
    ToolCallsRequested,
    TurnComplete,
    Usage,
)

from .conftest import CONVERSATION_ID, INSTITUTION_ID, TENANT_TOKEN, FakeApi

HEADERS = {"authorization": TENANT_TOKEN, "x-institution-id": INSTITUTION_ID}
BODY = {"conversationId": CONVERSATION_ID, "message": "How is attendance in class 6B?"}


# -- helpers -------------------------------------------------------------------------------


class ScriptedProvider:
    """
    A provider that replays a fixed script of turns.

    Used instead of the mock provider wherever the *shape* of the model's behaviour is the thing
    under test - an endless tool loop, for instance, which no honest provider would produce and
    which therefore has no business being a switch inside the shipped mock.
    """

    key = "scripted"
    model = "scripted-1"

    def __init__(self, turns: Iterable[list[ProviderEvent]] | Callable[[int], list[ProviderEvent]]):
        self._turns = turns
        self.turn = 0
        self.requests: list[CompletionRequest] = []

    def credential_status(self) -> CredentialStatus:
        return CredentialStatus(configured=True)

    async def aclose(self) -> None:
        return None

    async def stream(self, request: CompletionRequest) -> AsyncIterator[ProviderEvent]:
        self.requests.append(request)
        index = self.turn
        self.turn += 1
        events = (
            self._turns(index) if callable(self._turns) else list(self._turns)[index]
        )
        for item in events:
            yield item


def parse_sse(raw: str) -> list[tuple[str, Any]]:
    """
    Parse the response body as SSE, strictly.

    Every block must carry exactly one `event:` line and one `data:` line, and the data must be
    valid JSON on a single line. A parser that is lenient here would let a malformed stream pass.
    """
    events: list[tuple[str, Any]] = []
    for block in raw.split("\n\n"):
        if not block.strip():
            continue
        lines = block.split("\n")
        names = [line[len("event: ") :] for line in lines if line.startswith("event: ")]
        payloads = [line[len("data: ") :] for line in lines if line.startswith("data: ")]
        assert len(names) == 1, f"malformed SSE block: {block!r}"
        assert len(payloads) == 1, f"malformed SSE block: {block!r}"
        events.append((names[0], json.loads(payloads[0])))
    return events


async def run_chat(
    client: httpx.AsyncClient, body: dict[str, Any] | None = None
) -> httpx.Response:
    return await client.post("/chat", json=body or BODY, headers=HEADERS)


# -- the happy path ------------------------------------------------------------------------


async def test_the_stream_is_well_formed_sse(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]],
) -> None:
    client = await build_client()

    response = await run_chat(client)

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    # A buffering proxy would turn the stream into one late blob.
    assert response.headers["x-accel-buffering"] == "no"
    assert "x-request-id" in response.headers

    events = parse_sse(response.text)
    names = [name for name, _ in events]

    assert names[0] == "meta"
    assert names[-1] == "done"
    assert "delta" in names
    assert events[-1][1]["ok"] is True
    # The answer arrives as more than one fragment, i.e. it really streams.
    assert len([name for name in names if name == "delta"]) > 1


async def test_the_manifest_is_fetched_with_the_callers_token_before_anything_else(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]], fake_api: FakeApi
) -> None:
    client = await build_client()

    await run_chat(client)

    assert fake_api.paths()[0] == "/api/v1/ai/tools"
    assert fake_api.calls[0].headers["authorization"] == TENANT_TOKEN
    assert fake_api.calls[0].headers["x-institution-id"] == INSTITUTION_ID


async def test_a_tool_call_goes_back_through_the_api_with_the_same_token(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]], fake_api: FakeApi
) -> None:
    # The shipped mock provider reaches for a tool whose name the question mentions.
    client = await build_client()

    response = await run_chat(
        client, {"conversationId": CONVERSATION_ID, "message": "attendance summary for 6B"}
    )
    events = parse_sse(response.text)

    tool_events = [payload for name, payload in events if name == "tool"]
    assert {"name": "attendance.summary", "status": "started"} in tool_events
    assert {"name": "attendance.summary", "status": "completed"} in tool_events

    invoke = [call for call in fake_api.calls if call.url.path.endswith("/invoke")]
    assert len(invoke) == 1
    assert invoke[0].url.path == "/api/v1/ai/tools/attendance.summary/invoke"
    assert invoke[0].headers["authorization"] == TENANT_TOKEN


async def test_the_exchange_is_persisted_through_the_api_with_the_raw_user_message(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]], fake_api: FakeApi
) -> None:
    client = await build_client()

    await run_chat(client)

    stored = fake_api.bodies_for("/conversations/")
    assert len(stored) == 1
    messages = stored[0]["messages"]
    assert messages[0]["role"] == "user"
    # The envelope is a prompt artefact; storing it would make the conversation unreadable.
    assert messages[0]["content"] == BODY["message"]
    assert "BEGIN-UNTRUSTED" not in json.dumps(stored[0])
    assert messages[1]["role"] == "assistant"
    assert messages[1]["usage"]["outputTokens"] >= 0


async def test_citations_are_forwarded_only_when_a_tool_supplied_them(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]], fake_api: FakeApi
) -> None:
    fake_api.invoke_responses["knowledge.search"] = httpx.Response(
        200,
        json={
            "result": {"passages": ["Late arrival is recorded after 8:15."]},
            "citations": [{"title": "Student Handbook 2025", "documentId": "doc-1", "page": 4}],
        },
    )
    client = await build_client()

    with_citations = parse_sse(
        (
            await run_chat(
                client,
                {
                    "conversationId": CONVERSATION_ID,
                    "message": "knowledge search: late arrival rule",
                },
            )
        ).text
    )
    without = parse_sse((await run_chat(client)).text)

    cited = [payload for name, payload in with_citations if name == "citations"]
    assert len(cited) == 1
    assert cited[0]["citations"][0]["title"] == "Student Handbook 2025"
    assert [name for name, _ in without if name == "citations"] == []


# -- refusals ------------------------------------------------------------------------------


async def test_a_403_from_the_api_is_passed_through_unchanged(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]], fake_api: FakeApi
) -> None:
    body = {
        "error": {
            "code": "FORBIDDEN",
            "message": "You do not have permission to perform this action.",
            "requestId": "0192f5a0-0000-7000-8000-00000000ffff",
        }
    }
    fake_api.tools_response = httpx.Response(403, json=body)
    client = await build_client()

    response = await run_chat(client)

    assert response.status_code == 403
    assert response.json() == body
    # The gateway did not re-word it, did not add a code of its own, and did not try again.
    assert len([call for call in fake_api.calls if call.url.path == "/api/v1/ai/tools"]) == 1
    # And it did not fall back to answering without tools.
    assert "event:" not in response.text


async def test_a_401_from_the_api_is_passed_through_unchanged(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]], fake_api: FakeApi
) -> None:
    body = {"error": {"code": "UNAUTHENTICATED", "message": "Authentication is required."}}
    fake_api.tools_response = httpx.Response(401, json=body)
    client = await build_client()

    response = await run_chat(client)

    assert response.status_code == 401
    assert response.json() == body


async def test_a_403_on_a_tool_call_ends_the_stream_with_the_apis_own_refusal(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]], fake_api: FakeApi
) -> None:
    """
    A refusal that arrives after the headers cannot be a status line, so it becomes an error
    event - still carrying the API's own code, still not retried.
    """
    fake_api.invoke_responses["attendance.summary"] = httpx.Response(
        403, json={"error": {"code": "FORBIDDEN", "message": "Not permitted."}}
    )
    client = await build_client()

    events = parse_sse(
        (
            await run_chat(
                client,
                {"conversationId": CONVERSATION_ID, "message": "attendance summary please"},
            )
        ).text
    )

    errors = [payload for name, payload in events if name == "error"]
    assert len(errors) == 1
    assert errors[0]["status"] == 403
    assert errors[0]["error"]["code"] == "FORBIDDEN"
    assert events[-1][0] == "done"
    assert events[-1][1]["ok"] is False
    assert len([call for call in fake_api.calls if call.url.path.endswith("/invoke")]) == 1


async def test_a_tool_loop_that_exceeds_the_cap_is_refused(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]], fake_api: FakeApi
) -> None:
    """
    The cap exists because an injected prompt that induces an endless tool loop is a
    denial-of-service attack against the school's own inference budget.
    """
    provider = ScriptedProvider(
        lambda turn: [
            ToolCallsRequested(
                calls=(
                    ToolCall(
                        id=f"call-{turn}",
                        name="attendance.summary",
                        arguments={},
                        raw_arguments="{}",
                    ),
                )
            ),
            TurnComplete(stop_reason="tool_use", usage=Usage(input_tokens=10, output_tokens=1)),
        ]
    )
    client = await build_client(provider=provider)

    events = parse_sse((await run_chat(client)).text)

    errors = [payload for name, payload in events if name == "error"]
    assert len(errors) == 1
    assert errors[0]["error"]["code"] == "AI_TOOL_LOOP_LIMIT"
    # `ok: false`, so a client can tell a stopped exchange from a finished one without parsing
    # the error event - but still persisted, because the tokens were spent and a budget that
    # only counts successful exchanges is not a budget.
    assert events[-1][0] == "done"
    assert events[-1][1] == {"ok": False, "persisted": True}

    # Exactly the configured number of iterations ran - it refused rather than looping.
    invocations = [call for call in fake_api.calls if call.url.path.endswith("/invoke")]
    assert len(invocations) == 3  # ai_max_tool_iterations in the test settings
    assert provider.turn == 3


async def test_a_tool_the_manifest_does_not_contain_is_never_called(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]], fake_api: FakeApi
) -> None:
    provider = ScriptedProvider(
        [
            [
                ToolCallsRequested(
                    calls=(
                        ToolCall(
                            id="c1", name="payroll.run", arguments={}, raw_arguments="{}"
                        ),
                    )
                ),
                TurnComplete(stop_reason="tool_use"),
            ],
            [TextDelta(text="I cannot look that up."), TurnComplete(stop_reason="end_turn")],
        ]
    )
    client = await build_client(provider=provider)

    events = parse_sse((await run_chat(client)).text)

    assert ("tool", {"name": "payroll.run", "status": "refused"}) in events
    assert [call for call in fake_api.calls if "payroll" in call.url.path] == []
    assert events[-1][1]["ok"] is True


# -- input validation ----------------------------------------------------------------------


async def test_a_missing_token_is_refused_locally_without_calling_the_api(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]], fake_api: FakeApi
) -> None:
    client = await build_client()

    response = await client.post("/chat", json=BODY)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHENTICATED"
    assert fake_api.calls == []


async def test_an_authorization_header_outside_the_token_charset_is_refused(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]], fake_api: FakeApi
) -> None:
    """
    The header is copied into an outbound request, so its shape is checked before it is.

    A literal CR/LF is rejected by httpx itself before it could ever be sent; the charset check
    covers everything else a token has no business containing - spaces, quotes, control-adjacent
    punctuation - which is what a header-splitting attempt looks like once the obvious form is
    unavailable.
    """
    client = await build_client()

    for value in ('Bearer abcdefgh "x-institution-id: other"', "Bearer short", "Token abcdefgh"):
        response = await client.post("/chat", json=BODY, headers={"authorization": value})
        assert response.status_code == 401, value

    assert fake_api.calls == []


async def test_a_conversation_id_that_is_not_a_uuid_is_refused(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]], fake_api: FakeApi
) -> None:
    client = await build_client()

    response = await client.post(
        "/chat",
        json={"conversationId": "../../ai/tools", "message": "hello"},
        headers=HEADERS,
    )

    assert response.status_code == 400
    assert response.json()["error"]["code"] == "VALIDATION_FAILED"
    assert fake_api.calls == []


async def test_an_over_long_message_is_refused_before_the_provider_is_paid_for_it(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]], fake_api: FakeApi
) -> None:
    client = await build_client(ai_max_message_chars=50)

    response = await client.post(
        "/chat",
        json={"conversationId": CONVERSATION_ID, "message": "x" * 200},
        headers=HEADERS,
    )

    assert response.status_code == 400
    assert fake_api.calls == []


async def test_an_exchange_that_runs_past_the_wall_clock_is_refused(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]], fake_api: FakeApi
) -> None:
    """
    The iteration cap alone does not bound cost - one tool call against a slow report can take a
    minute on its own - so the deadline is checked before every model turn and every tool call.
    """
    client = await build_client(ai_max_wall_clock_seconds=0.0)

    events = parse_sse((await run_chat(client)).text)

    errors = [payload for name, payload in events if name == "error"]
    assert errors[0]["error"]["code"] == "AI_TIME_LIMIT"
    assert events[-1][1]["ok"] is False
    # Refused before the provider was paid for a single token.
    assert [name for name, _ in events if name == "delta"] == []


async def test_a_400_from_the_api_reaches_the_caller_intact(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]], fake_api: FakeApi
) -> None:
    """
    The `/ai/*` routes are institution-scoped, so a request without `x-institution-id` is
    refused by the API with guidance the caller can act on. The gateway must not bury that
    behind a generic 502.
    """
    body = {
        "error": {
            "code": "VALIDATION_FAILED",
            "message": "Send the x-institution-id header to indicate which institution this "
            "question is about.",
        }
    }
    fake_api.tools_response = httpx.Response(400, json=body)
    client = await build_client()

    response = await client.post("/chat", json=BODY, headers={"authorization": TENANT_TOKEN})

    assert response.status_code == 400
    assert response.json() == body


async def test_a_tool_that_rejects_the_models_arguments_does_not_end_the_exchange(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]], fake_api: FakeApi
) -> None:
    """
    A 400 on a tool call is the *model's* mistake, not the person's. It is reported back into
    the loop as a failed tool so the answer can still be attempted - unlike a 403, which is the
    person's answer and ends the exchange.
    """
    fake_api.invoke_responses["attendance.summary"] = httpx.Response(
        400, json={"error": {"code": "VALIDATION_FAILED", "message": "studentId is required."}}
    )
    client = await build_client()

    events = parse_sse(
        (
            await run_chat(
                client,
                {"conversationId": CONVERSATION_ID, "message": "attendance summary please"},
            )
        ).text
    )

    assert ("tool", {"name": "attendance.summary", "status": "failed"}) in events
    assert events[-1][0] == "done"
    assert events[-1][1]["ok"] is True
    assert [name for name, _ in events if name == "delta"] != []
