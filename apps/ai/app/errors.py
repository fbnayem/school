"""
The error envelope.

Shape-compatible with `toErrorResponse` in `@shikkha/shared`, so a browser or a mobile client
parses a failure from the gateway with exactly the code it already uses for the API:

    {"error": {"code": "...", "message": "...", "requestId": "..."}}

The rules from docs/07 §6 apply here unchanged. Stack traces, provider error bodies and the
names of missing credentials never reach a client — they go to the log under the request id.
An authorization failure never names the missing permission; that is free reconnaissance.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "GatewayError",
    "ProviderCredentialsMissing",
    "ProviderError",
    "UpstreamAuthError",
    "UpstreamClientError",
    "UpstreamError",
    "UpstreamRefusal",
    "error_body",
]

_GENERIC = {
    404: "The requested resource was not found",
    502: "An upstream service is currently unavailable",
}
_GENERIC_DEFAULT = (
    "Something went wrong. If this continues, contact your administrator with the request ID."
)


def error_body(code: str, message: str, request_id: str | None) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if request_id:
        error["requestId"] = request_id
    return {"error": error}


class GatewayError(Exception):
    """
    A failure with a public code and a safe message.

    `context` is for the log only. It is where a missing credential name, an upstream body or a
    provider's complaint goes; none of it is serialised into a response.
    """

    status: int = 500
    code: str = "INTERNAL_ERROR"
    is_public: bool = True

    def __init__(self, message: str, **context: Any) -> None:
        super().__init__(message)
        self.message = message
        self.context = context

    def public_message(self) -> str:
        if self.is_public:
            return self.message
        return _GENERIC.get(self.status, _GENERIC_DEFAULT)

    def body(self, request_id: str | None) -> dict[str, Any]:
        return error_body(self.code, self.public_message(), request_id)


class UpstreamRefusal(Exception):
    """
    A 4xx from `apps/api`, carried verbatim — same status, same bytes, same code.

    This is not converted into a `GatewayError` on purpose. docs/07 gives `apps/api` authority
    over authentication, authorization and the shape of a request; when it says the caller may
    not do that, or forgot the institution header, that *is* the answer. The gateway re-wording
    it would at best lose information and at worst invent an opinion of its own. Masking it as a
    502 would be worse still: it would turn a mistake the caller can fix into an outage they
    cannot.

    5xx is the opposite case and is **not** passed through — see `UpstreamError`. An upstream
    error message may carry a stack trace or a SQL fragment (docs/07 §6).
    """

    def __init__(self, status: int, raw_body: bytes, content_type: str | None) -> None:
        super().__init__(f"apps/api refused the delegated call with {status}")
        self.status = status
        self.raw_body = raw_body
        self.content_type = content_type or "application/json"


class UpstreamAuthError(UpstreamRefusal):
    """
    The 401/403 case, named separately because it carries a rule the others do not.

    It is **never retried**. There is nothing to retry with: this process holds exactly one
    credential per request, the caller's, and it has no others. That is a structural property,
    not a policy someone has to remember — and it is why this class has its own name and its own
    test rather than being folded into the parent.
    """


class UpstreamClientError(UpstreamRefusal):
    """Any other 4xx — a malformed argument, a missing header, an archived conversation."""


class UpstreamError(GatewayError):
    """`apps/api` failed for a reason that is not an authorization decision."""

    status = 502
    code = "EXTERNAL_SERVICE_ERROR"
    is_public = False


class ProviderError(GatewayError):
    """The inference provider failed. Its message never reaches the client."""

    status = 502
    code = "EXTERNAL_SERVICE_ERROR"
    is_public = False


class ProviderCredentialsMissing(ProviderError):
    """
    A configured provider has no credentials.

    Refuses loudly, and names the missing variable **in the context only** — the client sees
    the generic upstream message. Naming an unset environment variable to an unauthenticated
    caller tells them which integration to probe next.
    """

    def __init__(self, provider: str, missing: tuple[str, ...]) -> None:
        super().__init__(
            f"provider {provider} is selected but its credentials are not configured",
            provider=provider,
            missingCredential=missing[0] if missing else None,
            missingCredentials=list(missing),
        )
