"""
The application.

Boot order matters here, so it is explicit:

  1. **Refuse to start if the environment carries database credentials.** This runs before
     anything else, including logging configuration, because a process that should not exist
     should not get as far as opening a port. See `guards.py` for why this is the security
     property rather than a nicety.
  2. Configure structured logging with the API's field names.
  3. Build the provider and the callback client, and report - once, at boot - which provider is
     configured and whether its credentials are present. That line is where an operator looks
     when `/healthz` says `credentialsPresent: false`, because it is the only place the missing
     variable's *name* appears.

`apps/api` prints its public route list on every boot for the same reason (docs/07 section 3):
the public surface is the attack surface, and it should be short enough to read in the logs.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from .api_client import ApiClient
from .config import Settings, get_settings
from .context import current_request_id
from .errors import GatewayError, UpstreamRefusal, error_body
from .guards import assert_no_database_credentials
from .logs import configure_logging, get_logger
from .middleware import RequestContextMiddleware
from .orchestrator import ChatOrchestrator
from .providers import AIProvider, build_provider
from .routers import chat, health

__all__ = ["create_app"]

logger = get_logger("ai.main")


def create_app(
    settings: Settings | None = None,
    *,
    api_client: ApiClient | None = None,
    provider: AIProvider | None = None,
) -> FastAPI:
    """
    Build the application.

    `api_client` and `provider` are the test seam: the suite passes instances backed by
    `httpx.MockTransport` so the whole gateway can be exercised without a Node API and without a
    vendor. Nothing in production passes them, and an injected object is closed by whoever
    created it rather than by the lifespan.
    """
    # First, before anything else. A deployment that handed this service a connection string
    # must not reach the point of serving a request.
    assert_no_database_credentials()

    resolved = settings or get_settings()
    configure_logging(
        level=resolved.ai_log_level,
        service=resolved.ai_service_name,
        environment=resolved.ai_environment,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        owns_dependencies = provider is None and api_client is None
        active_provider = provider or build_provider(resolved)
        active_client = api_client or ApiClient(resolved)
        app.state.settings = resolved
        app.state.provider = active_provider
        app.state.api_client = active_client
        app.state.orchestrator = ChatOrchestrator(resolved, active_client, active_provider)

        credentials = active_provider.credential_status()
        logger.info(
            "ai gateway starting",
            extra={
                "provider": active_provider.key,
                "model": active_provider.model,
                "credentialsPresent": credentials.configured,
                # Names only, and only in the log. Never in a response (docs/07 section 6).
                "missingCredentials": list(credentials.missing),
                "apiBaseUrl": resolved.ai_api_base_url,
                "maxToolIterations": resolved.ai_max_tool_iterations,
                "maxWallClockSeconds": resolved.ai_max_wall_clock_seconds,
                # Stated on every boot so it is visible in any environment's logs that this
                # service holds no database credentials and reaches data only through the API.
                "databaseCredentials": "none by design",
            },
        )
        if not credentials.configured:
            logger.error(
                "the configured provider has no credentials and will refuse every request",
                extra={
                    "provider": active_provider.key,
                    "missingCredentials": list(credentials.missing),
                },
            )

        try:
            yield
        finally:
            if owns_dependencies:
                await active_client.aclose()
                await active_provider.aclose()

    app = FastAPI(
        title="Shikkha AI gateway",
        version="0.1.0",
        summary="Prompt assembly, provider routing and delegated tool calls. No database.",
        lifespan=lifespan,
        # No interactive docs by default: this service is reached by apps/web and apps/api, not
        # by a browser looking for a schema to explore.
        docs_url="/docs" if resolved.ai_environment != "production" else None,
        redoc_url=None,
    )

    app.add_middleware(RequestContextMiddleware)

    origins = resolved.cors_origin_list()
    if origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=origins,
            allow_credentials=False,
            allow_methods=["GET", "POST"],
            allow_headers=["authorization", "content-type", "x-institution-id", "x-request-id"],
            expose_headers=["x-request-id"],
        )

    app.include_router(health.router)
    app.include_router(chat.router)

    _install_exception_handlers(app)
    return app


def _install_exception_handlers(app: FastAPI) -> None:
    """
    One error envelope, matching `@shikkha/shared`.

    Every failure leaves through here so a stack trace, a provider's complaint or an upstream
    body can never reach a client. The detail is in the log under the request id; the client
    gets a stable code, a safe message and that id to quote.
    """

    @app.exception_handler(UpstreamRefusal)
    async def _auth(_: Request, exc: UpstreamRefusal) -> Response:
        # Verbatim. `apps/api` decides authorization; this service only carries the answer.
        return Response(
            content=exc.raw_body, status_code=exc.status, media_type=exc.content_type
        )

    @app.exception_handler(GatewayError)
    async def _gateway(_: Request, exc: GatewayError) -> JSONResponse:
        request_id = current_request_id()
        if exc.status >= 500:
            logger.error("request failed", extra={"code": exc.code, "context": exc.context})
        else:
            logger.warning("request refused", extra={"code": exc.code, "context": exc.context})
        return JSONResponse(status_code=exc.status, content=exc.body(request_id))

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        # The field paths are safe to return; the submitted values are not, and pydantic's
        # default handler includes them.
        issues = [
            {"path": ".".join(str(part) for part in error["loc"][1:]), "message": error["msg"]}
            for error in exc.errors()
        ]
        body = error_body("VALIDATION_FAILED", "The request is not valid.", current_request_id())
        body["error"]["issues"] = issues
        return JSONResponse(status_code=400, content=body)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        codes = {401: "UNAUTHENTICATED", 403: "FORBIDDEN", 404: "NOT_FOUND", 429: "RATE_LIMITED"}
        fallback = "VALIDATION_FAILED" if exc.status_code < 500 else "INTERNAL_ERROR"
        code = codes.get(exc.status_code, fallback)
        message = str(exc.detail) if exc.status_code < 500 else "Something went wrong."
        return JSONResponse(
            status_code=exc.status_code,
            content=error_body(code, message, current_request_id()),
        )

    @app.exception_handler(Exception)
    async def _unhandled(_: Request, exc: Exception) -> JSONResponse:
        logger.error("unhandled error", exc_info=exc)
        return JSONResponse(
            status_code=500,
            content=error_body(
                "INTERNAL_ERROR",
                "Something went wrong. If this continues, contact your administrator with the "
                "request ID.",
                current_request_id(),
            ),
        )


# No module-level application object. `uvicorn app.main:create_app --factory` builds it, which
# keeps the database-credential assertion and the settings parse inside a call the test suite can
# make with its own environment rather than at import time.
