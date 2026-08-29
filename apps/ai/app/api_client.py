"""
The callback client - the only way this service reaches data.

Every method here sends the **caller's own bearer token**, unchanged, and nothing else. This
process holds no service account, no API key for `apps/api`, no database URL. That is the whole
architecture in one sentence: the gateway cannot fetch anything the person talking to it could
not fetch themselves, because it has no other identity to fetch it with.

Two rules that look like implementation details and are not:

**Every 4xx is passed through unchanged, and 401/403 above all.** `apps/api` is the sole
authority on authentication and authorization (docs/07 section 3), and on what a valid request
looks like. Its refusal is the answer - same status, same body, same code. Re-wording it here
would at best lose information and at worst amount to the gateway forming an authorization
opinion of its own; masking it as a 502 would turn a mistake the caller can fix into an apparent
outage. 5xx is the opposite case: an upstream error may carry a stack trace or a SQL fragment,
so it becomes a generic 502 with the detail in the log (docs/07 section 6).

**Nothing is ever retried after a status response.** Not a 403, not a 401, not a 429. The reason
a 403 retry is impossible is structural rather than disciplinary: a retry would need different
credentials, and there are none in this process. The only retry in this file is on a connection
failure to a *read-only* endpoint, where nothing has happened yet.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

from .config import Settings
from .errors import UpstreamAuthError, UpstreamClientError, UpstreamError
from .logs import get_logger
from .schemas import TOOL_NAME, ToolManifestResponse

__all__ = ["ApiClient", "CallerAuth"]

logger = get_logger("ai.api-client")

# One retry, connection failures only, GET only. A read that never reached the server has had no
# effect, so repeating it is safe; anything the server answered is final.
_CONNECT_RETRIES = 1


@dataclass(frozen=True, slots=True)
class CallerAuth:
    """
    Everything this service knows about who is asking: one header value it did not mint.

    `institution_id` is forwarded because `apps/api`'s `TenantGuard` resolves the institution
    from `x-institution-id` and validates it against the principal's grants. The tenant is never
    forwarded, and could not be: the API takes it from the session, never from a header.
    """

    authorization: str
    institution_id: str | None
    request_id: str


class ApiClient:
    def __init__(
        self, settings: Settings, *, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._settings = settings
        self._client = httpx.AsyncClient(
            base_url=f"{settings.ai_api_base_url}/{settings.ai_api_prefix}",
            transport=transport,
            timeout=httpx.Timeout(
                settings.ai_api_timeout_seconds,
                connect=settings.ai_api_connect_timeout_seconds,
            ),
            # Redirects are refused. A 302 from the API would send the caller's bearer token to
            # whatever host the Location header names.
            follow_redirects=False,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    # -- the three delegated endpoints ---------------------------------------------------

    async def list_tools(self, auth: CallerAuth) -> ToolManifestResponse:
        """
        The manifest of tools *this caller* may use.

        Fetched before the response stream opens, so an authorization refusal is still an HTTP
        status the client can act on rather than an error event inside a 200.
        """
        payload = await self._request("GET", "ai/tools", auth, retry_on_connect_error=True)
        return ToolManifestResponse.model_validate(payload)

    async def invoke_tool(
        self, auth: CallerAuth, name: str, arguments: dict[str, Any]
    ) -> dict[str, Any]:
        """
        Invoke one tool on the caller's behalf.

        The name is re-validated even though the orchestrator only ever passes a name it took
        from the manifest. It is interpolated into a URL path, and a model-supplied
        `../../users` would otherwise be a path-traversal into a different endpoint entirely.
        """
        if not TOOL_NAME.match(name) or len(name) > 64:
            raise UpstreamError("refused to invoke a tool with an unacceptable name", tool=name)
        return await self._request(
            "POST",
            f"ai/tools/{name}/invoke",
            auth,
            json={"arguments": arguments},
        )

    async def append_messages(
        self, auth: CallerAuth, conversation_id: str, messages: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """
        Persist the exchange.

        Written by the API, inside the API's transaction, under the caller's own identity - so
        the row lands in the right tenant, under row-level security, with an audit trail that
        records a human as the actor and the AI as the initiator.
        """
        return await self._request(
            "POST",
            f"ai/conversations/{conversation_id}/messages",
            auth,
            json={"messages": messages},
        )

    async def api_is_live(self) -> bool:
        """Readiness only. Public route, so no caller token is involved."""
        try:
            response = await self._client.get("health/live", timeout=3.0)
        except httpx.HTTPError:
            return False
        return response.status_code == httpx.codes.OK

    # -- internals -----------------------------------------------------------------------

    def _headers(self, auth: CallerAuth) -> dict[str, str]:
        headers = {
            # Verbatim. Not parsed, not decoded, not re-signed - this service has no key to
            # re-sign with and no business knowing what is inside.
            "authorization": auth.authorization,
            "accept": "application/json",
            "x-request-id": auth.request_id,
        }
        if auth.institution_id:
            headers["x-institution-id"] = auth.institution_id
        return headers

    async def _request(
        self,
        method: str,
        path: str,
        auth: CallerAuth,
        *,
        json: dict[str, Any] | None = None,
        retry_on_connect_error: bool = False,
    ) -> dict[str, Any]:
        attempts = 1 + (_CONNECT_RETRIES if retry_on_connect_error else 0)
        last_error: httpx.HTTPError | None = None

        for attempt in range(attempts):
            try:
                response = await self._client.request(
                    method, path, headers=self._headers(auth), json=json
                )
            except httpx.HTTPError as error:
                # Never reached the server, so nothing happened and a repeat is safe.
                last_error = error
                if attempt + 1 < attempts:
                    continue
                logger.error(
                    "apps/api unreachable",
                    extra={"method": method, "path": path, "attempts": attempts},
                )
                raise UpstreamError("apps/api is unreachable", path=path) from error

            return self._interpret(response, method, path)

        raise UpstreamError("apps/api is unreachable", path=path) from last_error

    def _interpret(self, response: httpx.Response, method: str, path: str) -> dict[str, Any]:
        if response.status_code in (httpx.codes.UNAUTHORIZED, httpx.codes.FORBIDDEN):
            logger.warning(
                "delegated call refused by apps/api",
                extra={"method": method, "path": path, "status": response.status_code},
            )
            # Carried on as raw bytes so the response the client receives is the API's own,
            # byte for byte. Re-serialising it would drop fields the API adds later.
            raise UpstreamAuthError(
                status=response.status_code,
                raw_body=response.content,
                content_type=response.headers.get("content-type"),
            )

        if httpx.codes.BAD_REQUEST <= response.status_code < httpx.codes.INTERNAL_SERVER_ERROR:
            # Any other 4xx is the API telling the caller something they can act on - a missing
            # x-institution-id, an archived conversation, an argument the tool's schema rejects.
            # Masking it as a 502 would turn a fixable mistake into an apparent outage.
            logger.info(
                "delegated call rejected by apps/api",
                extra={"method": method, "path": path, "status": response.status_code},
            )
            raise UpstreamClientError(
                status=response.status_code,
                raw_body=response.content,
                content_type=response.headers.get("content-type"),
            )

        if response.status_code >= httpx.codes.INTERNAL_SERVER_ERROR:
            logger.error(
                "delegated call failed",
                extra={
                    "method": method,
                    "path": path,
                    "status": response.status_code,
                    # The body may quote a record; it stays in the log (docs/07 section 6).
                    "detail": response.text[:1_000],
                },
            )
            raise UpstreamError(
                f"apps/api returned {response.status_code}",
                path=path,
                status=response.status_code,
            )

        if not response.content:
            return {}
        try:
            payload = response.json()
        except ValueError as error:
            raise UpstreamError("apps/api returned a non-JSON body", path=path) from error
        if not isinstance(payload, dict):
            raise UpstreamError("apps/api returned an unexpected body shape", path=path)
        return payload
