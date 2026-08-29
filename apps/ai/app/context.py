"""
Per-request context.

Deliberately narrow, and for the same reason as `apps/api/src/common/context/request-context.ts`:
the request id is needed by the logger and by the callback client, two places that would
otherwise need the request object threaded through code with no other reason to know about HTTP.

What is **not** here is the principal. This service never decodes the caller's token — it has
no signing key and no business forming an opinion about who the caller is. Identity is
`apps/api`'s answer to give, on every single call. Keeping a decoded principal in this process
would be the first step towards a local authorization decision, which is the thing docs/07 says
must not exist here.
"""

from __future__ import annotations

import os
import re
import secrets
import time
from contextvars import ContextVar, Token

__all__ = [
    "current_request_id",
    "reset_request_id",
    "resolve_request_id",
    "set_request_id",
    "uuid7",
]

# Same bound and charset as the API's `resolveRequestId`. An unvalidated inbound header ends up
# in logs and in the audit table on the other side, which is both a log-injection vector and a
# way to poison a search index.
_MAX_INBOUND_REQUEST_ID = 64
_SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9_.:-]+$")

_request_id: ContextVar[str | None] = ContextVar("shikkha_request_id", default=None)


def uuid7() -> str:
    """
    A UUIDv7, matching the ids `@shikkha/shared` generates on the Node side.

    Time-ordered rather than random so that ids sort by creation, which is what makes them
    usable as primary keys over there and readable in a log here.
    """
    timestamp_ms = int(time.time() * 1000) & 0xFFFFFFFFFFFF
    rand_a = secrets.randbits(12)
    rand_b = secrets.randbits(62)
    value = timestamp_ms << 80
    value |= 0x7 << 76
    value |= rand_a << 64
    value |= 0b10 << 62
    value |= rand_b
    hexed = f"{value:032x}"
    return f"{hexed[0:8]}-{hexed[8:12]}-{hexed[12:16]}-{hexed[16:20]}-{hexed[20:32]}"


def resolve_request_id(inbound: str | None) -> str:
    """Accept the caller's request id if it looks like an identifier, otherwise mint one."""
    if (
        inbound
        and len(inbound) <= _MAX_INBOUND_REQUEST_ID
        and _SAFE_REQUEST_ID.match(inbound) is not None
    ):
        return inbound
    return uuid7()


def set_request_id(request_id: str) -> Token[str | None]:
    return _request_id.set(request_id)


def reset_request_id(token: Token[str | None]) -> None:
    _request_id.reset(token)


def current_request_id() -> str | None:
    return _request_id.get()


# Exposed so the health endpoint can report uptime without importing the app object.
PROCESS_STARTED_AT = time.monotonic()
PROCESS_PID = os.getpid()
