"""
Server-sent-event parsing for the provider adapters.

All three vendor streaming APIs speak SSE, and `httpx` gives lines rather than events, so the
framing is done once here. Written against the WHATWG event-stream rules that actually matter
in practice: `:` comment lines are ignored, a blank line dispatches, multiple `data:` lines in
one event are joined with a newline, and one leading space after the colon is stripped.

Getting this wrong is subtle rather than loud — a multi-line `data:` payload silently parses as
truncated JSON — which is why it is a shared function with its own tests rather than three
copies inside the adapters.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import httpx

__all__ = ["iter_sse", "iter_sse_lines"]


async def iter_sse_lines(lines: AsyncIterator[str]) -> AsyncIterator[tuple[str | None, str]]:
    """Yield `(event_name, data)` pairs from a stream of already-split lines."""
    event: str | None = None
    data: list[str] = []

    async for raw in lines:
        line = raw.rstrip("\r")
        if line == "":
            if data:
                yield event, "\n".join(data)
            event, data = None, []
            continue
        if line.startswith(":"):
            continue
        name, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if name == "event":
            event = value
        elif name == "data":
            data.append(value)

    # A stream that ends without a trailing blank line still carries a final event.
    if data:
        yield event, "\n".join(data)


async def iter_sse(response: httpx.Response) -> AsyncIterator[tuple[str | None, str]]:
    async for item in iter_sse_lines(response.aiter_lines()):
        yield item
