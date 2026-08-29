"""
The health endpoints.

Both are unauthenticated, which makes them a reconnaissance surface: whatever they say, they say
to anyone who can reach the port. So the assertions here are mostly about what is *absent* - no
key, no fragment of a key, and not even the name of the variable that is missing, which would
tell a prober exactly which integration to go after next.
"""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable

import httpx

from .conftest import FakeApi

FAKE_KEY = "sk-test-DO-NOT-LEAK-9f3a2b1c8d7e6f5a"


async def test_healthz_reports_the_provider_without_the_credential(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]],
) -> None:
    client = await build_client(
        ai_provider="anthropic",
        anthropic_api_key=FAKE_KEY,
        openai_api_key=FAKE_KEY,
        gemini_api_key=FAKE_KEY,
    )

    response = await client.get("/healthz")
    body = response.json()

    assert response.status_code == 200
    assert body["status"] == "ok"
    assert body["provider"] == "anthropic"
    assert body["credentialsPresent"] is True

    raw = json.dumps(body)
    assert FAKE_KEY not in raw
    assert "sk-test" not in raw
    # Not even a suffix. A partial key is still a lead.
    assert "6f5a" not in raw


async def test_healthz_does_not_name_the_missing_variable(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]],
) -> None:
    """
    `credentialsPresent: false` is the whole message. The variable's name is in the startup log,
    which is where an operator looks and an attacker does not.
    """
    client = await build_client(ai_provider="openai", openai_api_key=None)

    body = (await client.get("/healthz")).json()

    assert body["credentialsPresent"] is False
    raw = json.dumps(body)
    assert "OPENAI_API_KEY" not in raw
    assert "API_KEY" not in raw


async def test_healthz_does_not_check_a_dependency(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]], fake_api: FakeApi
) -> None:
    """
    Liveness must not touch `apps/api`. A liveness probe that checks a dependency restarts every
    pod during a brief blip and turns a 30-second degradation into a full outage.
    """
    fake_api.live_response = httpx.Response(503, json={"status": "down"})
    client = await build_client()

    assert (await client.get("/healthz")).status_code == 200
    assert fake_api.calls == []


async def test_readyz_is_ready_when_the_api_answers(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]], fake_api: FakeApi
) -> None:
    client = await build_client()

    response = await client.get("/readyz")

    assert response.status_code == 200
    assert response.json() == {"status": "ready", "components": {"api": "up"}}
    assert fake_api.paths() == ["/api/v1/health/live"]


async def test_readyz_is_not_ready_when_the_api_is_unreachable(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]], fake_api: FakeApi
) -> None:
    """
    Without `apps/api` this service can do nothing at all - it has no other source of data and no
    other source of authorization - so an unreachable API is genuinely "not ready".
    """

    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    fake_api._handle = refuse  # type: ignore[method-assign]
    client = await build_client()

    response = await client.get("/readyz")

    assert response.status_code == 503
    assert response.json()["status"] == "not_ready"
    # The component is named; the reason is not (docs/07 section 6).
    assert response.json()["components"] == {"api": "down"}
    assert "connection refused" not in response.text


async def test_every_response_carries_the_request_id(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]],
) -> None:
    client = await build_client()

    response = await client.get("/healthz", headers={"x-request-id": "trace-abc.123"})

    # Accepted because it matches the API's charset rule, so one id spans both services.
    assert response.headers["x-request-id"] == "trace-abc.123"


async def test_a_hostile_request_id_is_replaced_rather_than_echoed(
    build_client: Callable[..., Awaitable[httpx.AsyncClient]],
) -> None:
    client = await build_client()

    response = await client.get("/healthz", headers={"x-request-id": "a b<script>" + "x" * 90})

    assert response.headers["x-request-id"] != "a b<script>" + "x" * 90
    assert len(response.headers["x-request-id"]) == 36
