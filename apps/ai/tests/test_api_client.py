"""
The callback into `apps/api`.

Three properties, and all three are security properties rather than conveniences:

  * the caller's `Authorization` header is forwarded verbatim and nothing else is added
  * a 401 or a 403 is carried back unchanged and **never retried**
  * a tool name is never interpolated into a URL path without being re-validated
"""

from __future__ import annotations

import httpx
import pytest

from app.api_client import ApiClient, CallerAuth
from app.config import Settings
from app.errors import UpstreamAuthError, UpstreamClientError, UpstreamError

from .conftest import CONVERSATION_ID, INSTITUTION_ID, TENANT_TOKEN

FORBIDDEN_BODY = {
    "error": {
        "code": "FORBIDDEN",
        "message": "You do not have permission to perform this action.",
        "requestId": "0192f5a0-0000-7000-8000-00000000ffff",
    }
}


def _auth() -> CallerAuth:
    return CallerAuth(
        authorization=TENANT_TOKEN,
        institution_id=INSTITUTION_ID,
        request_id="0192f5a0-0000-7000-8000-000000000abc",
    )


def _client(settings: Settings, handler: object) -> ApiClient:
    return ApiClient(settings, transport=httpx.MockTransport(handler))  # type: ignore[arg-type]


async def test_the_callers_token_is_forwarded_verbatim(settings: Settings) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"tools": []})

    api = _client(settings, handler)
    try:
        await api.list_tools(_auth())
    finally:
        await api.aclose()

    request = seen[0]
    assert request.headers["authorization"] == TENANT_TOKEN
    assert request.headers["x-institution-id"] == INSTITUTION_ID
    # Correlates this call with the same request in the API's own log.
    assert request.headers["x-request-id"] == "0192f5a0-0000-7000-8000-000000000abc"
    # No second credential of any kind. If one were ever added, a 403 would become retryable.
    assert "x-api-key" not in request.headers
    assert "cookie" not in request.headers


async def test_a_403_is_passed_through_unchanged_and_not_retried(settings: Settings) -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(403, json=FORBIDDEN_BODY)

    api = _client(settings, handler)
    try:
        with pytest.raises(UpstreamAuthError) as raised:
            await api.list_tools(_auth())
    finally:
        await api.aclose()

    assert attempts == 1, "a refusal was retried; there are no other credentials to retry with"
    assert raised.value.status == 403
    # Byte for byte, so a field the API adds later survives the trip.
    assert httpx.Response(403, json=FORBIDDEN_BODY).content == raised.value.raw_body


async def test_a_401_is_passed_through_unchanged_and_not_retried(settings: Settings) -> None:
    attempts = 0
    body = {"error": {"code": "UNAUTHENTICATED", "message": "Authentication is required."}}

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(401, json=body)

    api = _client(settings, handler)
    try:
        with pytest.raises(UpstreamAuthError) as raised:
            await api.invoke_tool(_auth(), "attendance.summary", {})
    finally:
        await api.aclose()

    assert attempts == 1
    assert raised.value.status == 401


async def test_a_tool_name_that_could_traverse_the_path_is_refused_before_the_call(
    settings: Settings,
) -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={})

    api = _client(settings, handler)
    try:
        hostile = (
            "../../users",
            "attendance.summary/../../admin",
            "Attendance.Summary",
            "a" * 80,
        )
        for name in hostile:
            with pytest.raises(UpstreamError):
                await api.invoke_tool(_auth(), name, {})
    finally:
        await api.aclose()

    assert calls == 0, "a model-supplied name reached the network"


async def test_a_5xx_is_not_leaked_to_the_caller(settings: Settings) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="stack trace: at StudentsService.findAll (students.ts:41)")

    api = _client(settings, handler)
    try:
        with pytest.raises(UpstreamError) as raised:
            await api.list_tools(_auth())
    finally:
        await api.aclose()

    # The detail is in `context` for the log; the public message is generic.
    assert "students.ts" not in raised.value.public_message()
    assert raised.value.public_message() == "An upstream service is currently unavailable"


async def test_a_read_that_never_reached_the_server_is_retried_once(settings: Settings) -> None:
    """A connection failure means nothing happened, so repeating it is safe."""
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise httpx.ConnectError("connection refused", request=request)
        return httpx.Response(200, json={"tools": []})

    api = _client(settings, handler)
    try:
        manifest = await api.list_tools(_auth())
    finally:
        await api.aclose()

    assert attempts == 2
    assert manifest.tools == []


async def test_a_write_that_failed_to_connect_is_not_retried(settings: Settings) -> None:
    """A POST may have been received and acted on; repeating it could double-write."""
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        raise httpx.ConnectError("connection refused", request=request)

    api = _client(settings, handler)
    try:
        with pytest.raises(UpstreamError):
            await api.append_messages(_auth(), CONVERSATION_ID, [])
    finally:
        await api.aclose()

    assert attempts == 1


async def test_another_4xx_is_also_passed_through_rather_than_masked(settings: Settings) -> None:
    """
    A 400 from apps/api - a missing `x-institution-id`, an argument its schema rejects - is a
    mistake the caller can fix. Masking it as a 502 would turn that into an apparent outage.
    """
    body = {
        "error": {
            "code": "VALIDATION_FAILED",
            "message": "Send the x-institution-id header to indicate which institution this "
            "question is about.",
        }
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json=body)

    api = _client(settings, handler)
    try:
        with pytest.raises(UpstreamClientError) as raised:
            await api.list_tools(_auth())
    finally:
        await api.aclose()

    assert raised.value.status == 400
    assert httpx.Response(400, json=body).content == raised.value.raw_body
    # And a 401/403 is still its own, never-retried case rather than one of these.
    assert not isinstance(raised.value, UpstreamAuthError)
