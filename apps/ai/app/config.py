"""
Environment configuration.

Parsed once at boot and frozen, mirroring `apps/api/src/config/env.ts`: a missing or malformed
variable is a startup failure with a readable message rather than an `Optional` that surfaces
three hours later as a confusing runtime error.

The `_refuse_unsafe_production` block at the bottom is the part worth reading. It refuses to
start in production with the mock provider, because a mock that fabricates plausible answers
about a child's attendance is worse than an outage, and with a wildcard CORS origin, because
this gateway forwards the caller's bearer token.

Credentials are `SecretStr`. Pydantic renders those as `**********` in every repr, so a model
dump that reaches a log line or a health response cannot carry a key.
"""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from pydantic import SecretStr, ValidationInfo, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

__all__ = ["ProviderKey", "Settings", "get_settings", "reset_settings_cache"]

ProviderKey = Literal["mock", "openai", "anthropic", "gemini"]

LogLevel = Literal["fatal", "error", "warn", "info", "debug", "trace", "silent"]


class Settings(BaseSettings):
    """Every environment variable this service reads. Documented in README.md."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        # The process environment holds hundreds of unrelated variables; only the declared
        # fields are read. Note that `guards.assert_no_database_credentials` inspects the
        # *whole* environment separately — ignoring extras here must not become a way for a
        # connection string to slip in unnoticed.
        extra="ignore",
        frozen=True,
    )

    ai_environment: Literal["development", "test", "production"] = "development"
    ai_port: int = 8000
    ai_host: str = "0.0.0.0"  # noqa: S104 — containers bind all interfaces; the edge is elsewhere
    ai_log_level: LogLevel = "info"
    ai_service_name: str = "shikkha-ai"

    # --- The callback to apps/api -------------------------------------------------------
    # This is the only way this service reaches data. There is no second path.
    ai_api_base_url: str = "http://localhost:4000"
    ai_api_prefix: str = "api/v1"
    ai_api_timeout_seconds: float = 20.0
    ai_api_connect_timeout_seconds: float = 5.0

    # --- Provider -----------------------------------------------------------------------
    ai_provider: ProviderKey = "mock"
    # None means "the adapter's documented default". Pinning a model in configuration rather
    # than in code is what makes a provider change configuration rather than a deploy.
    ai_model: str | None = None
    ai_max_output_tokens: int = 4096

    # --- Caps on the tool-call loop ------------------------------------------------------
    # Both caps exist for the same reason: an injected prompt that induces an endless tool
    # loop is a denial-of-service attack against the school's own inference budget, and the
    # school is on a fixed subscription (docs/06 §8).
    ai_max_tool_iterations: int = 6
    ai_max_wall_clock_seconds: float = 45.0

    # Bounds on what a caller may submit and on what a tool may feed back into the prompt.
    ai_max_message_chars: int = 8_000
    ai_max_tool_result_chars: int = 20_000

    ai_cors_origins: str = ""

    # --- Provider credentials ------------------------------------------------------------
    openai_api_key: SecretStr | None = None
    openai_base_url: str = "https://api.openai.com/v1"
    anthropic_api_key: SecretStr | None = None
    anthropic_base_url: str = "https://api.anthropic.com"
    anthropic_version: str = "2023-06-01"
    gemini_api_key: SecretStr | None = None
    gemini_base_url: str = "https://generativelanguage.googleapis.com"

    @field_validator("ai_api_base_url", "openai_base_url", "anthropic_base_url", "gemini_base_url")
    @classmethod
    def _no_trailing_slash(cls, value: str) -> str:
        if not value.startswith(("http://", "https://")):
            raise ValueError("must be an http(s) URL")
        return value.rstrip("/")

    @field_validator("ai_api_prefix")
    @classmethod
    def _clean_prefix(cls, value: str) -> str:
        return value.strip("/")

    @field_validator("ai_max_tool_iterations")
    @classmethod
    def _bounded_iterations(cls, value: int) -> int:
        if not 1 <= value <= 20:
            raise ValueError("must be between 1 and 20; the cap is a safety control, not a knob")
        return value

    @field_validator("ai_cors_origins")
    @classmethod
    def _refuse_unsafe_production(cls, value: str, info: ValidationInfo) -> str:
        # Runs on the last-declared field that matters so the earlier ones are already parsed.
        environment = info.data.get("ai_environment")
        provider = info.data.get("ai_provider")
        if environment != "production":
            return value
        if provider == "mock":
            raise ValueError(
                "AI_PROVIDER=mock is refused in production: the mock provider fabricates "
                "answers, and a fabricated answer about a child is worse than an outage"
            )
        if "*" in value:
            raise ValueError(
                "AI_CORS_ORIGINS must not contain a wildcard in production; this service "
                "receives the caller's bearer token"
            )
        return value

    # --- Derived -------------------------------------------------------------------------

    def api_url(self, path: str) -> str:
        """Absolute URL for an `apps/api` route, e.g. `api_url("ai/tools")`."""
        return f"{self.ai_api_base_url}/{self.ai_api_prefix}/{path.lstrip('/')}"

    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.ai_cors_origins.split(",") if origin.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    """Test helper — drops the memoised settings so a suite can vary the environment."""
    get_settings.cache_clear()
