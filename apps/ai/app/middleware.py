"""
Request-scoped plumbing.

Written as raw ASGI rather than as Starlette's `BaseHTTPMiddleware` on purpose: that class
pumps the response through an anyio memory stream, which buffers a streaming body and would
undo the whole point of `/chat`. Raw ASGI passes the frames straight through.
"""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

from .context import current_request_id, reset_request_id, resolve_request_id, set_request_id
from .logs import get_logger

__all__ = ["RequestContextMiddleware"]

Scope = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[MutableMapping[str, Any]]]
Send = Callable[[MutableMapping[str, Any]], Awaitable[None]]

logger = get_logger("ai.http")


class RequestContextMiddleware:
    """
    Establishes the request id and logs the completed request.

    The inbound `x-request-id` is accepted only if it matches the API's charset and length rule
    (`context.resolve_request_id`), so the two services agree on what an id may look like and
    neither can be used to inject into the other's logs. It is echoed back on the response, and
    forwarded on every call into `apps/api`, which is what makes one support ticket retrieve the
    whole trace across both processes.
    """

    def __init__(self, app: Callable[[Scope, Receive, Send], Awaitable[None]]) -> None:
        self._app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return

        inbound = _header(scope, b"x-request-id")
        request_id = resolve_request_id(inbound)
        token = set_request_id(request_id)
        started = time.monotonic()
        status_holder: dict[str, int] = {}

        async def send_wrapper(message: MutableMapping[str, Any]) -> None:
            if message["type"] == "http.response.start":
                status_holder["status"] = int(message["status"])
                headers = list(message.get("headers") or [])
                headers.append((b"x-request-id", request_id.encode("ascii")))
                message["headers"] = headers
            await send(message)

        try:
            await self._app(scope, receive, send_wrapper)
        finally:
            path = str(scope.get("path", ""))
            # Health probes would otherwise dominate the log at one line every few seconds.
            level = "debug" if path in ("/healthz", "/readyz") else "info"
            getattr(logger, level)(
                "request completed",
                extra={
                    "method": scope.get("method"),
                    "path": path,
                    "status": status_holder.get("status"),
                    "durationMs": int((time.monotonic() - started) * 1000),
                    "requestId": current_request_id(),
                },
            )
            reset_request_id(token)


def _header(scope: Scope, name: bytes) -> str | None:
    for key, value in scope.get("headers") or []:
        if key.lower() == name:
            # latin-1 is the ASGI header encoding; it cannot fail, which matters because a
            # decode error here would reject a request for the sake of a log field.
            return str(bytes(value).decode("latin-1"))
    return None
