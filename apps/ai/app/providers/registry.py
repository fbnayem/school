"""
Provider selection.

This is the only place in the service that knows a vendor's name. Everything above it holds an
`AIProvider` and cannot tell which one it has, which is what docs/06 section 4 means by "a
provider change is configuration".

A provider with missing credentials is still constructed and still registered. It refuses at the
point of use, loudly, naming the variable in the log - the pattern from
`apps/api/src/modules/transport/providers/stub-gps.provider.ts`. Refusing to construct it instead
would turn a missing key into an unexplained boot loop, and silently falling back to `mock` would
be the worst outcome of the three: a school would get invented answers and no signal at all.
"""

from __future__ import annotations

import httpx

from ..config import Settings
from .anthropic import AnthropicProvider
from .base import AIProvider
from .gemini import GeminiProvider
from .mock import MockProvider
from .openai import OpenAIProvider

__all__ = ["build_provider"]


def build_provider(
    settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None
) -> AIProvider:
    """
    Construct the configured adapter.

    `transport` is injected by the tests so a provider can be driven with `httpx.MockTransport`
    against canned vendor bytes. Nothing in production passes it.
    """
    if settings.ai_provider == "mock":
        return MockProvider(model=settings.ai_model)

    def client(base_url: str) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=base_url,
            transport=transport,
            timeout=httpx.Timeout(
                # Generous read timeout: a long completion legitimately takes minutes, and the
                # orchestrator's own wall-clock cap is the bound that actually matters.
                timeout=None,
                connect=settings.ai_api_connect_timeout_seconds,
                read=None,
                write=30.0,
                pool=10.0,
            ),
        )

    if settings.ai_provider == "openai":
        return OpenAIProvider(
            client=client(settings.openai_base_url),
            api_key=settings.openai_api_key,
            model=settings.ai_model,
        )
    if settings.ai_provider == "anthropic":
        return AnthropicProvider(
            client=client(settings.anthropic_base_url),
            api_key=settings.anthropic_api_key,
            api_version=settings.anthropic_version,
            model=settings.ai_model,
        )
    if settings.ai_provider == "gemini":
        return GeminiProvider(
            client=client(settings.gemini_base_url),
            api_key=settings.gemini_api_key,
            model=settings.ai_model,
        )

    # Unreachable while AI_PROVIDER is a Literal, but a future value added to the enum without
    # an adapter must not silently become "mock".
    raise ValueError(f"no adapter is registered for AI_PROVIDER={settings.ai_provider!r}")
