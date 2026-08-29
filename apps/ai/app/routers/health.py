"""
Health endpoints.

Two, and they answer different questions, for the reason spelled out in
`apps/api/src/modules/health/health.controller.ts`: a liveness probe that checks a dependency
restarts every pod during a brief blip and turns a 30-second degradation into a full outage.

  * `/healthz` - is the process up, and is the configured provider actually usable?
  * `/readyz`  - can this instance serve traffic, which here means: can it reach `apps/api`?
                 Without the API this service can do nothing at all - it has no other source of
                 data and no other source of authorization.

Neither endpoint emits a secret. `/healthz` reports *whether* credentials are present, never
which variable is missing and never any part of a key: an unauthenticated health endpoint is a
reconnaissance surface, and "OPENAI_API_KEY is unset" tells a prober exactly which integration
to go after. The missing variable name is in the startup log instead, where an operator will
look for it.
"""

from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Request, Response, status

from ..context import PROCESS_STARTED_AT

router = APIRouter(tags=["health"])


@router.get("/healthz")
async def healthz(request: Request) -> dict[str, Any]:
    provider = request.app.state.provider
    credentials = provider.credential_status()
    return {
        "status": "ok",
        "service": request.app.state.settings.ai_service_name,
        "provider": provider.key,
        "model": provider.model,
        # A boolean, deliberately. See the module docstring.
        "credentialsPresent": credentials.configured,
        "uptimeSeconds": int(time.monotonic() - PROCESS_STARTED_AT),
    }


@router.get("/readyz")
async def readyz(request: Request, response: Response) -> dict[str, Any]:
    reachable = await request.app.state.api_client.api_is_live()
    if not reachable:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    # The component name is returned; the failure detail is not (docs/07 section 6).
    return {
        "status": "ready" if reachable else "not_ready",
        "components": {"api": "up" if reachable else "down"},
    }
