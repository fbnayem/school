"""Shared plumbing for the three adapters that talk to a vendor over HTTP."""

from __future__ import annotations

import httpx
from pydantic import SecretStr

from ..errors import ProviderCredentialsMissing, ProviderError
from ..logs import get_logger
from .base import CredentialStatus

__all__ = ["HttpProvider"]

logger = get_logger("ai.provider")


class HttpProvider:
    """
    Credential handling and error translation, common to openai / anthropic / gemini.

    The refusal behaviour is the one from `apps/api/src/modules/transport/providers/
    stub-gps.provider.ts`: a missing credential is a **loud** failure that names the variable in
    the log, never a silent fallback and never a fabricated success. A gateway that quietly
    answered from nothing would be worse than one that is down, because nobody would know the
    answer was invented.
    """

    key: str = "http"
    model: str = ""

    def credential_status(self) -> CredentialStatus:  # pragma: no cover - overridden
        raise NotImplementedError

    def _require_credentials(self) -> None:
        status = self.credential_status()
        if not status.configured:
            logger.error(
                "provider refused: credentials missing",
                extra={"provider": self.key, "missingCredentials": list(status.missing)},
            )
            raise ProviderCredentialsMissing(self.key, status.missing)

    def _secret(self, value: SecretStr | None) -> str:
        """
        The configured key, or a loud refusal.

        Every adapter reads its credential through here so that "is it configured" and "give me
        the value" can never disagree - the second check is what keeps the type checker honest
        without an `assert`, which `python -O` would strip.
        """
        self._require_credentials()
        if value is None or not value.get_secret_value():
            raise ProviderCredentialsMissing(self.key, self.credential_status().missing)
        return value.get_secret_value()

    async def _raise_for_status(self, response: httpx.Response) -> None:
        if response.status_code < 400:
            return
        # The body may quote the prompt, which may quote a student's record. It goes to the
        # log under the request id and no further (docs/07 §6).
        detail = (await response.aread()).decode("utf-8", errors="replace")[:2_000]
        logger.error(
            "provider request failed",
            extra={
                "provider": self.key,
                "status": response.status_code,
                "detail": detail,
            },
        )
        raise ProviderError(
            f"{self.key} returned {response.status_code}",
            provider=self.key,
            status=response.status_code,
        )
