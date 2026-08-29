"""
Structured logging.

Two things are asserted: the field names match `apps/api/src/common/logger.ts` so both services
join on `requestId` in an aggregator, and the redaction list actually removes what it claims to.
A log aggregator is a far softer target than the database, and this service handles both
children's records and provider API keys.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from pydantic import SecretStr

from app.context import reset_request_id, set_request_id
from app.logs import JsonFormatter, redact


def _format(record_extras: dict[str, Any], msg: str = "hello") -> dict[str, Any]:
    formatter = JsonFormatter(service="shikkha-ai", environment="test")
    record = logging.LogRecord(
        name="ai.test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=msg,
        args=(),
        exc_info=None,
    )
    for key, value in record_extras.items():
        setattr(record, key, value)
    parsed: dict[str, Any] = json.loads(formatter.format(record))
    return parsed


def test_the_field_names_match_the_apis() -> None:
    token = set_request_id("trace-abc.123")
    try:
        line = _format({})
    finally:
        reset_request_id(token)

    assert line["service"] == "shikkha-ai"
    assert line["env"] == "test"
    assert line["level"] == "info"
    assert line["msg"] == "hello"
    assert line["requestId"] == "trace-abc.123"
    # ISO timestamps: aggregators and humans both read them, unlike epoch millis.
    assert line["time"].startswith("20")


def test_warning_is_logged_as_warn_so_a_dashboard_filter_catches_it() -> None:
    formatter = JsonFormatter(service="shikkha-ai", environment="test")
    record = logging.LogRecord(
        name="ai.test",
        level=logging.WARNING,
        pathname=__file__,
        lineno=1,
        msg="x",
        args=(),
        exc_info=None,
    )

    assert json.loads(formatter.format(record))["level"] == "warn"


def test_credentials_and_personal_data_are_redacted_at_any_depth() -> None:
    line = _format(
        {
            "authorization": "Bearer real.token.value",
            "upstream": {"headers": {"authorization": "Bearer other"}, "apiKey": "sk-live-123"},
            "student": [{"name": "Rafi", "nationalId": "1990123456789"}],
        }
    )

    raw = json.dumps(line)
    assert "real.token.value" not in raw
    assert "sk-live-123" not in raw
    assert "1990123456789" not in raw
    # The shape survives, so the line is still useful for debugging.
    assert line["student"][0]["name"] == "Rafi"


def test_a_secret_value_object_never_serialises_its_contents() -> None:
    assert redact(SecretStr("sk-live-123")) == "[redacted]"
    assert redact({"nested": SecretStr("sk-live-123")}) == {"nested": "[redacted]"}
