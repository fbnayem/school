"""
SSE framing, in both directions.

Outbound: the frames this service writes must be legal events - one `event:` line, one `data:`
line, no raw newline inside the data.

Inbound: the parser the provider adapters share. A multi-line `data:` payload silently parses as
truncated JSON if the joining rule is wrong, which produces a plausible-looking wrong answer
rather than an error - the worst failure mode available.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator

from app.providers._sse import iter_sse_lines
from app.sse import comment, event


async def _lines(text: str) -> AsyncIterator[str]:
    for line in text.split("\n"):
        yield line


def test_an_event_is_one_event_line_and_one_data_line() -> None:
    frame = event("delta", {"text": "hello"}).decode()

    assert frame == 'event: delta\ndata: {"text":"hello"}\n\n'


def test_a_newline_in_the_payload_cannot_break_the_framing() -> None:
    frame = event("delta", {"text": "line one\nline two"}).decode()

    body = frame.split("\n")
    assert len(body) == 4  # event, data, blank, trailing empty
    assert json.loads(body[1][len("data: ") :])["text"] == "line one\nline two"


def test_a_comment_carries_no_parseable_event() -> None:
    assert comment("keep-alive").decode() == ": keep-alive\n\n"


async def test_the_parser_joins_multi_line_data_with_a_newline() -> None:
    stream = "event: message\ndata: {\ndata:   \"a\": 1\ndata: }\n\n"

    parsed = [item async for item in iter_sse_lines(_lines(stream))]

    assert parsed == [("message", '{\n  "a": 1\n}')]
    assert json.loads(parsed[0][1]) == {"a": 1}


async def test_the_parser_ignores_comments_and_strips_one_leading_space() -> None:
    stream = ": heartbeat\nevent: ping\ndata:  padded\n\n"

    parsed = [item async for item in iter_sse_lines(_lines(stream))]

    assert parsed == [("ping", " padded")]


async def test_a_stream_that_ends_without_a_blank_line_still_yields_its_last_event() -> None:
    stream = 'data: {"done":true}'

    parsed = [item async for item in iter_sse_lines(_lines(stream))]

    assert parsed == [(None, '{"done":true}')]
