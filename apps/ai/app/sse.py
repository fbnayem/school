"""
Server-sent-event framing for the `/chat` response.

SSE rather than a websocket because the traffic is one-directional and short-lived, and because
it survives the same proxies and the same bearer-token auth as every other request in this
system. A websocket would need its own authentication story, which is exactly the kind of second
implementation docs/06 section 5 argues against for retrieval.

The framing rules that matter: `data:` must not contain a raw newline (JSON with
`ensure_ascii=False` and no indent cannot produce one), and an event is dispatched by a blank
line. Everything else in this file exists to stop an intermediary buffering the stream, which
turns a live answer into a long pause followed by the whole thing at once.
"""

from __future__ import annotations

import json
from typing import Any

__all__ = ["SSE_HEADERS", "comment", "event"]

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    # nginx buffers proxied responses by default, which defeats streaming entirely. This is the
    # documented opt-out and is ignored by proxies that do not know it.
    "X-Accel-Buffering": "no",
}


def event(name: str, data: Any) -> bytes:
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"), default=str)
    return f"event: {name}\ndata: {payload}\n\n".encode()


def comment(text: str) -> bytes:
    """A comment line. Keeps an idle connection alive without emitting a parseable event."""
    return f": {text}\n\n".encode()
