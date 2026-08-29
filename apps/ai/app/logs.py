"""
Structured logging.

The field names are copied from `apps/api/src/common/logger.ts` — `time`, `level`, `service`,
`env`, `requestId`, `msg` — so that a single request that crosses both services produces one
correlatable trace in the aggregator. A gateway whose logs cannot be joined to the API's logs
is a gateway whose failures cannot be explained.

Two properties matter more than the formatter:

 1. **Every line carries the request id**, taken from the async context rather than passed
    around, exactly as pino's `mixin` does on the Node side.
 2. **Personal data and credentials never reach the logs.** The redaction list mirrors the
    API's. This service handles children's records and provider API keys; a log aggregator is
    a far softer target than the database.
"""

from __future__ import annotations

import json
import logging
import sys
from datetime import UTC, datetime
from typing import Any

from pydantic import SecretStr

from .context import current_request_id

__all__ = ["configure_logging", "get_logger", "redact"]

# Mirrors REDACTED_PATHS in apps/api/src/common/logger.ts. Matched on the key name at any
# depth, so an object logged by accident is redacted too.
_REDACTED_KEYS = frozenset(
    {
        "authorization",
        "cookie",
        "set-cookie",
        "password",
        "passwordhash",
        "password_hash",
        "currentpassword",
        "newpassword",
        "token",
        "accesstoken",
        "refreshtoken",
        "tokenhash",
        "bearer",
        "apikey",
        "api_key",
        "secret",
        "mfasecret",
        "mfarecoverycodes",
        "nationalid",
        "national_id",
        "birthregistrationnumber",
        "birth_registration_number",
        "bankaccountnumber",
        "bank_account_number",
        "medicalconditions",
        "allergies",
        "specialneeds",
    }
)

_CENSOR = "[redacted]"

# pino level labels. Python's WARNING/CRITICAL have different names, and a dashboard filtering
# on `level: "warn"` should catch this service's warnings too.
_LEVEL_LABELS = {
    logging.CRITICAL: "fatal",
    logging.ERROR: "error",
    logging.WARNING: "warn",
    logging.INFO: "info",
    logging.DEBUG: "debug",
}

_PYTHON_LEVELS = {
    "fatal": logging.CRITICAL,
    "error": logging.ERROR,
    "warn": logging.WARNING,
    "info": logging.INFO,
    "debug": logging.DEBUG,
    "trace": logging.DEBUG,
    "silent": logging.CRITICAL + 10,
}

#: Attributes that are not caller-supplied context. `color_message` is uvicorn's ANSI-coloured
#: duplicate of the message; in a JSON line it is escape codes and noise, and it doubles the
#: size of every access log entry.
_RESERVED = frozenset(vars(logging.makeLogRecord({}))) | {"color_message", "taskName"}


def redact(value: Any) -> Any:
    """Recursively replace sensitive values. Applied at serialisation time, like pino's."""
    if isinstance(value, SecretStr):
        return _CENSOR
    if isinstance(value, dict):
        return {
            key: (
                _CENSOR
                if isinstance(key, str) and key.lower().replace("-", "") in _REDACTED_KEYS
                else redact(item)
            )
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    return value


class JsonFormatter(logging.Formatter):
    """One JSON object per line, with the API's field names."""

    def __init__(self, service: str, environment: str) -> None:
        super().__init__()
        self._service = service
        self._environment = environment

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            # ISO timestamps: aggregators and humans both read them, unlike epoch millis.
            "time": datetime.fromtimestamp(record.created, tz=UTC).isoformat(
                timespec="milliseconds"
            ),
            "level": _LEVEL_LABELS.get(record.levelno, record.levelname.lower()),
            "service": self._service,
            "env": self._environment,
            "module": record.name,
            "msg": record.getMessage(),
        }

        request_id = current_request_id()
        if request_id:
            payload["requestId"] = request_id

        # Anything passed as `extra=` lands on the record; merge it in, redacted.
        extras = {key: value for key, value in vars(record).items() if key not in _RESERVED}
        payload.update(redact(extras))

        if record.exc_info:
            # The message and type, never the full traceback in the structured field — the
            # traceback goes on its own key so a log pipeline can drop it if it wants to.
            payload["err"] = {
                "type": getattr(record.exc_info[0], "__name__", "Error"),
                "message": str(record.exc_info[1]),
                "stack": self.formatException(record.exc_info),
            }

        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging(*, level: str, service: str, environment: str) -> None:
    """Install the JSON formatter on the root logger. Idempotent."""
    root = logging.getLogger()
    root.handlers.clear()
    handler = logging.StreamHandler(stream=sys.stdout)
    handler.setFormatter(JsonFormatter(service=service, environment=environment))
    root.addHandler(handler)
    root.setLevel(_PYTHON_LEVELS.get(level, logging.INFO))

    # uvicorn installs its own colourised handlers; without this the same request is logged
    # twice, once structured and once not.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uvicorn_logger = logging.getLogger(name)
        uvicorn_logger.handlers.clear()
        uvicorn_logger.propagate = True


def get_logger(name: str) -> logging.Logger:
    """A logger tagged with a module name, for use inside a service."""
    return logging.getLogger(name)
