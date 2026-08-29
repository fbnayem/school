"""
Shared fixtures.

Nothing in this suite touches the network. Every call into `apps/api` and every call to a vendor
goes through `httpx.MockTransport`, which means the tests assert on the bytes this service
actually sends rather than on a mock of its own design - and it means the suite runs in CI with
no Node API, no database and no credentials, which is the same set of nothing this service runs
with in production.
"""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import AsyncExitStack
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from app.api_client import ApiClient
from app.config import Settings
from app.guards import find_database_credentials
from app.main import create_app
from app.providers.base import AIProvider

TENANT_TOKEN = "Bearer test.access.token-abcdefghijklmnop"
CONVERSATION_ID = "0192f5a0-0000-7000-8000-000000000001"
INSTITUTION_ID = "0192f5a0-0000-7000-8000-0000000000aa"


@pytest.fixture(autouse=True)
def _hermetic_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """
    Scrub the process environment so the suite tests the code rather than the developer's shell.

    Two groups go:

      * database-shaped variables. A developer's shell often has `DATABASE_URL` exported for the
        Node side, and the startup guard would then fail every test that builds the app - for a
        correct reason, but not the one under test. `test_startup_guard.py` proves the guard
        still fires, by handing it an environment directly.
      * `AI_*` and vendor keys. A real `ANTHROPIC_API_KEY` in the shell would otherwise make
        `credentialsPresent` true in a test that asserts it is false.
    """
    for name in find_database_credentials(dict(os.environ)):
        monkeypatch.delenv(name, raising=False)
    for name in list(os.environ):
        if name.startswith("AI_") or name.endswith(("_API_KEY", "_BASE_URL")):
            monkeypatch.delenv(name, raising=False)


@pytest.fixture
def settings() -> Settings:
    return Settings(
        _env_file=None,  # type: ignore[call-arg]
        ai_environment="test",
        ai_provider="mock",
        ai_log_level="silent",
        ai_api_base_url="http://api.test",
        ai_api_prefix="api/v1",
        ai_max_tool_iterations=3,
        ai_max_wall_clock_seconds=10.0,
    )


class FakeApi:
    """
    A stand-in for `apps/api`, recording what the gateway sent it.

    `calls` is what the assertions about retries are made against: a 403 that was retried would
    appear here twice.
    """

    def __init__(self) -> None:
        self.calls: list[httpx.Request] = []
        self.tools_response: httpx.Response = httpx.Response(
            200,
            json={
                "tools": [
                    {
                        "name": "attendance.summary",
                        "description": "Attendance percentages for a student or a section.",
                        "parameters": {
                            "type": "object",
                            "properties": {"studentId": {"type": "string"}},
                        },
                    },
                    {
                        "name": "knowledge.search",
                        "description": "Search the school's own documents.",
                        "parameters": {
                            "type": "object",
                            "properties": {"query": {"type": "string"}},
                        },
                    },
                ]
            },
        )
        self.invoke_responses: dict[str, httpx.Response] = {}
        self.default_invoke: httpx.Response = httpx.Response(
            200, json={"result": {"present": 0.93}}
        )
        self.messages_response: httpx.Response = httpx.Response(201, json={"stored": 2})
        self.live_response: httpx.Response = httpx.Response(200, json={"status": "ok"})

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        path = request.url.path

        if path == "/api/v1/health/live":
            return self.live_response
        if path == "/api/v1/ai/tools":
            return self.tools_response
        if path.startswith("/api/v1/ai/tools/") and path.endswith("/invoke"):
            name = path[len("/api/v1/ai/tools/") : -len("/invoke")]
            return self.invoke_responses.get(name, self.default_invoke)
        if path.startswith("/api/v1/ai/conversations/"):
            return self.messages_response

        return httpx.Response(404, json={"error": {"code": "NOT_FOUND", "message": "no route"}})

    # -- convenience -------------------------------------------------------------------

    def paths(self) -> list[str]:
        return [call.url.path for call in self.calls]

    def bodies_for(self, path_fragment: str) -> list[Any]:
        return [
            json.loads(call.content)
            for call in self.calls
            if path_fragment in call.url.path and call.content
        ]


@pytest.fixture
def fake_api() -> FakeApi:
    return FakeApi()


@pytest.fixture
async def build_client(
    settings: Settings, fake_api: FakeApi
) -> AsyncIterator[Callable[..., Awaitable[httpx.AsyncClient]]]:
    """
    Drive the real application over `httpx.ASGITransport`.

    Starlette's own `TestClient` is not used: it now requires a different major version of httpx
    than the service itself depends on, and pinning two copies of an HTTP client in a service
    whose dependency set is a security control would be a poor trade for a convenience. Going
    through the ASGI transport directly also exercises the raw middleware, which is where the
    request id is established.

    The lifespan is entered explicitly, because that is where the provider, the callback client
    and the orchestrator are wired onto `app.state`.
    """
    stack = AsyncExitStack()

    async def _build(
        provider: AIProvider | None = None, **overrides: Any
    ) -> httpx.AsyncClient:
        # Rebuilt through the constructor rather than `model_copy`, so an override is validated
        # and coerced the same way an environment variable would be.
        resolved = (
            Settings(_env_file=None, **{**settings.model_dump(), **overrides})  # type: ignore[call-arg]
            if overrides
            else settings
        )
        api_client = ApiClient(resolved, transport=fake_api.transport())
        application: FastAPI = create_app(resolved, api_client=api_client, provider=provider)
        await stack.enter_async_context(application.router.lifespan_context(application))
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application), base_url="http://ai.test"
        )
        await stack.enter_async_context(client)
        return client

    try:
        yield _build
    finally:
        await stack.aclose()
