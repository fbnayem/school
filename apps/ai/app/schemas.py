"""
Request and response models.

Validation here is not about tidiness. Three of these constraints are security controls:

  * `conversation_id` must be a UUID, because it is interpolated into the path of a call back
    into `apps/api`. An unvalidated identifier in a URL path is a request-forgery primitive.
  * `message` is length-bounded, because prompt size is what the school pays for.
  * `authorization` is shape-checked, because a header value with a newline in it is a request
    smuggling attempt, not a typo.
"""

from __future__ import annotations

import re
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

__all__ = [
    "CHAT_REQUEST_MAX_MESSAGE_CHARS",
    "ChatRequest",
    "Citation",
    "ToolManifestEntry",
    "ToolManifestResponse",
]

# Matches any UUID version. `apps/api` issues v7; accepting the whole family means a fixture or
# a seeded conversation from another version is not rejected for the wrong reason.
_UUID = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

# Same vocabulary the API's permission catalogue uses for tool names: dotted lowercase.
TOOL_NAME = re.compile(r"^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$")

# A hard ceiling independent of AI_MAX_MESSAGE_CHARS, so a misconfigured deployment cannot
# accept a megabyte of prompt.
CHAT_REQUEST_MAX_MESSAGE_CHARS = 32_000


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    conversation_id: str = Field(alias="conversationId")
    message: str = Field(min_length=1, max_length=CHAT_REQUEST_MAX_MESSAGE_CHARS)

    @field_validator("conversation_id")
    @classmethod
    def _uuid(cls, value: str) -> str:
        if not _UUID.match(value):
            raise ValueError("conversationId must be a UUID")
        return value


class ToolManifestEntry(BaseModel):
    """One tool `apps/api` says this caller may use."""

    model_config = ConfigDict(extra="ignore")

    name: str
    description: str = ""
    # The JSON Schema the API will validate arguments against. Passed to the provider verbatim.
    parameters: dict[str, Any] = Field(default_factory=lambda: {"type": "object", "properties": {}})

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        if not TOOL_NAME.match(value) or len(value) > 64:
            raise ValueError("tool name is not in the expected dotted-lowercase form")
        return value


class ToolManifestResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    tools: list[ToolManifestEntry] = Field(default_factory=list)


class Citation(BaseModel):
    """
    A source a knowledge tool supplied.

    Never constructed by this service from a model's output - only copied out of a tool result.
    A citation the gateway invented would be worse than no citation, because it would look like
    grounding (docs/06 section 5).
    """

    model_config = ConfigDict(extra="allow")

    title: str | None = None
    source: str | None = None
    documentId: str | None = None
    snippet: str | None = None
