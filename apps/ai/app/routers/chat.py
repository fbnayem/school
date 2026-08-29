"""
`POST /chat` - the gateway endpoint.

The one thing to understand about this handler is where its authority comes from: nowhere. It
holds the caller's `Authorization` header, passes it on, and has nothing else. It does not
decode the token, does not cache a decision from it, and cannot obtain a different one.

The ordering is deliberate. The tool manifest is fetched **before** the streaming response
begins, so an authorization refusal from `apps/api` is still a real HTTP status carrying the
API's own body - 403 stays 403, byte for byte. Once the first SSE frame is on the wire the status
line is spent, and a refusal can only be an error event.
"""

from __future__ import annotations

import json
import re

from fastapi import APIRouter, Header, Request, Response
from fastapi.responses import StreamingResponse

from ..api_client import CallerAuth
from ..context import current_request_id
from ..errors import GatewayError, UpstreamRefusal, error_body
from ..logs import get_logger
from ..orchestrator import ChatOrchestrator
from ..schemas import ChatRequest
from ..sse import SSE_HEADERS

router = APIRouter(tags=["chat"])
logger = get_logger("ai.chat")

# `Bearer <token>`, where the token is the printable subset RFC 7235 allows. Checked because
# this value is copied into an outbound request header: a value containing CR or LF is a
# request-smuggling attempt rather than a malformed token.
_AUTHORIZATION = re.compile(r"^Bearer [A-Za-z0-9._~+/=-]{8,4096}$")

# Institution ids are UUIDs on the API side. Validated for the same reason.
_INSTITUTION_ID = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


@router.post("/chat")
async def chat(
    request: Request,
    payload: ChatRequest,
    authorization: str | None = Header(default=None),
    x_institution_id: str | None = Header(default=None),
) -> Response:
    request_id = current_request_id()
    settings = request.app.state.settings

    if not authorization or not _AUTHORIZATION.match(authorization):
        # Refused locally rather than forwarded. Sending an absent or malformed credential to
        # `apps/api` only to relay the 401 back would be a round trip that teaches nobody
        # anything - and the envelope below is the same one the API would have produced.
        return _json_error(
            401,
            error_body("UNAUTHENTICATED", "Authentication is required.", request_id),
        )

    if x_institution_id and not _INSTITUTION_ID.match(x_institution_id):
        return _json_error(
            400,
            error_body("VALIDATION_FAILED", "x-institution-id must be a UUID.", request_id),
        )

    if len(payload.message) > settings.ai_max_message_chars:
        return _json_error(
            400,
            error_body(
                "VALIDATION_FAILED",
                f"The message must be {settings.ai_max_message_chars} characters or fewer.",
                request_id,
            ),
        )

    auth = CallerAuth(
        authorization=authorization,
        institution_id=x_institution_id,
        request_id=request_id or "",
    )
    orchestrator: ChatOrchestrator = request.app.state.orchestrator

    try:
        prepared = await orchestrator.prepare(auth, payload.message)
    except UpstreamRefusal as refusal:
        # Passed through unchanged: same status, same bytes, same content type. A 401 or 403 is
        # never retried - there are no other credentials in this process to retry with - and no
        # 4xx is retried either, because the API already gave its answer.
        return Response(
            content=refusal.raw_body,
            status_code=refusal.status,
            media_type=refusal.content_type,
        )
    except GatewayError as error:
        logger.error(
            "could not prepare the exchange",
            extra={"code": error.code, "context": error.context},
        )
        return _json_error(error.status, error.body(request_id))

    logger.info(
        "chat accepted",
        extra={
            "conversationId": payload.conversation_id,
            "tools": len(prepared.tools),
            "messageChars": len(payload.message),
        },
    )

    return StreamingResponse(
        orchestrator.stream(auth, payload.conversation_id, prepared),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


def _json_error(status_code: int, body: dict[str, object]) -> Response:
    return Response(
        content=json.dumps(body, ensure_ascii=False),
        status_code=status_code,
        media_type="application/json",
    )
