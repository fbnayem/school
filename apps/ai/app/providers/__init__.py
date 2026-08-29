"""Provider adapters. No application logic references a vendor (docs/06 §4)."""

from .base import (
    AIProvider,
    CompletionRequest,
    CredentialStatus,
    Message,
    ProviderEvent,
    TextDelta,
    ToolCall,
    ToolCallsRequested,
    ToolSpec,
    TurnComplete,
    Usage,
)
from .registry import build_provider

__all__ = [
    "AIProvider",
    "CompletionRequest",
    "CredentialStatus",
    "Message",
    "ProviderEvent",
    "TextDelta",
    "ToolCall",
    "ToolCallsRequested",
    "ToolSpec",
    "TurnComplete",
    "Usage",
    "build_provider",
]
