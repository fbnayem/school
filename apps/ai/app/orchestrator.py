"""
The model loop.

The sequence, in the order docs/06 section 1 draws it:

  1. ask `apps/api` which tools **this caller** may use, with the caller's own token
  2. assemble the prompt - instructions, then the manifest, then the caller's message inside a
     labelled data envelope
  3. run the loop: the model asks for a tool, the gateway calls it back through `apps/api` with
     the caller's token, and feeds the result in as a `tool` message
  4. persist the exchange through `apps/api`
  5. stream the answer, and the citations any knowledge tool supplied

Three refusals are built in, and each of them is load-bearing.

**The iteration cap.** A prompt injection that induces an endless tool loop is a denial-of-service
attack against the school's own inference budget. Schools here are on fixed subscriptions
(docs/06 section 8), so an unbounded loop is not a slow request - it is a bill the school never
agreed to. When the cap is reached the exchange is refused and reported, never silently
truncated into an answer that looks complete.

**The wall-clock cap.** The iteration cap alone does not bound cost: one tool call against a slow
report can take a minute on its own. The deadline is checked before every model turn and before
every tool call, and it is checked against a monotonic clock so a clock adjustment cannot extend
it.

**The manifest check.** A tool the model names but the manifest does not contain is never called.
`apps/api` would refuse it anyway - that is the defence that actually holds - but calling it would
turn a model hallucination into a stream of 403s in the security log, which is noise in exactly
the place where noise is expensive.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any

from .api_client import ApiClient, CallerAuth
from .config import Settings
from .context import current_request_id
from .errors import (
    GatewayError,
    UpstreamAuthError,
    UpstreamClientError,
    UpstreamError,
    UpstreamRefusal,
)
from .logs import get_logger
from .prompt import build_initial_messages, new_envelope_nonce, wrap_as_data
from .providers.base import (
    AIProvider,
    CompletionRequest,
    Message,
    TextDelta,
    ToolCall,
    ToolCallsRequested,
    ToolSpec,
    TurnComplete,
    Usage,
)
from .sse import event

__all__ = ["ChatOrchestrator", "PreparedChat"]

logger = get_logger("ai.orchestrator")


@dataclass
class PreparedChat:
    """Everything settled before the response stream opens, so refusals are still HTTP statuses."""

    tools: tuple[ToolSpec, ...]
    nonce: str
    messages: list[Message]
    user_message: str


@dataclass
class _Totals:
    input_tokens: int = 0
    output_tokens: int = 0
    tool_calls: int = 0
    citations: list[dict[str, Any]] = field(default_factory=list)
    #: Set when a cap was hit. The exchange is still persisted - the tokens were spent, and a
    #: budget that only counts successful exchanges is not a budget - but it must not be
    #: reported as a completed answer.
    refused: bool = False


class ChatOrchestrator:
    def __init__(self, settings: Settings, api: ApiClient, provider: AIProvider) -> None:
        self._settings = settings
        self._api = api
        self._provider = provider

    async def prepare(self, auth: CallerAuth, user_message: str) -> PreparedChat:
        """
        Fetch the manifest and assemble the prompt.

        Deliberately outside the streaming generator. A 401 or 403 raised here becomes a real
        HTTP status with the API's own body; the same refusal raised after the first byte could
        only be an error event inside a 200, which a client is far more likely to mishandle.
        """
        manifest = await self._api.list_tools(auth)
        tools = tuple(
            ToolSpec(name=entry.name, description=entry.description, parameters=entry.parameters)
            for entry in manifest.tools
        )
        nonce = new_envelope_nonce()
        messages = build_initial_messages(user_message=user_message, tools=tools, nonce=nonce)
        return PreparedChat(
            tools=tools, nonce=nonce, messages=messages, user_message=user_message
        )

    async def stream(
        self, auth: CallerAuth, conversation_id: str, prepared: PreparedChat
    ) -> AsyncIterator[bytes]:
        """
        Run the loop and yield SSE frames.

        This generator never raises. Once the response headers are on the wire a client cannot
        be told anything except through the stream, so every failure is converted into an
        `error` event followed by `done` - which is also what lets a client distinguish "the
        answer ended" from "the connection dropped".
        """
        request_id = current_request_id()
        totals = _Totals()
        answer_parts: list[str] = []
        tool_calls_made: list[dict[str, Any]] = []
        deadline = time.monotonic() + self._settings.ai_max_wall_clock_seconds

        yield event(
            "meta",
            {
                "conversationId": conversation_id,
                "requestId": request_id,
                "provider": self._provider.key,
                "model": self._provider.model,
                "tools": [tool.name for tool in prepared.tools],
            },
        )

        try:
            async for frame in self._run_loop(
                auth, prepared, totals, answer_parts, tool_calls_made, deadline
            ):
                yield frame
        except UpstreamRefusal as refusal:
            # A refusal that arrives mid-stream is still the API's answer and is still passed
            # through unchanged - the status and the body verbatim, wrapped only enough to be a
            # legal SSE frame. The status line is already spent, so this is the only channel
            # left; a client reads the same code it would have read from a 403.
            yield event("error", _auth_refusal_payload(refusal))
            yield event("done", {"ok": False})
            return
        except GatewayError as error:
            logger.error(
                "chat failed", extra={"code": error.code, "context": error.context}, exc_info=error
            )
            yield event("error", error.body(request_id))
            yield event("done", {"ok": False})
            return
        except Exception as error:
            logger.error("chat failed unexpectedly", exc_info=error)
            yield event(
                "error",
                {
                    "error": {
                        "code": "INTERNAL_ERROR",
                        "message": "Something went wrong. If this continues, contact your "
                        "administrator with the request ID.",
                        "requestId": request_id,
                    }
                },
            )
            yield event("done", {"ok": False})
            return

        answer = "".join(answer_parts)

        if totals.citations:
            yield event("citations", {"citations": totals.citations})

        persisted = await self._persist(
            auth, conversation_id, prepared, answer, tool_calls_made, totals
        )

        yield event(
            "usage",
            {
                "inputTokens": totals.input_tokens,
                "outputTokens": totals.output_tokens,
                "toolCalls": totals.tool_calls,
                "provider": self._provider.key,
                "model": self._provider.model,
            },
        )
        # `ok` is false whenever a cap refused the exchange, even though the frames above are
        # identical: a client must be able to tell a finished answer from a stopped one without
        # parsing the error event.
        yield event("done", {"ok": not totals.refused, "persisted": persisted})

    # -- the loop ------------------------------------------------------------------------

    async def _run_loop(
        self,
        auth: CallerAuth,
        prepared: PreparedChat,
        totals: _Totals,
        answer_parts: list[str],
        tool_calls_made: list[dict[str, Any]],
        deadline: float,
    ) -> AsyncIterator[bytes]:
        messages = prepared.messages
        max_iterations = self._settings.ai_max_tool_iterations

        for iteration in range(max_iterations + 1):
            if time.monotonic() > deadline:
                yield self._refuse(
                    totals,
                    "AI_TIME_LIMIT",
                    "This request took too long and was stopped. Try asking for something "
                    "narrower - a single class, or a shorter date range.",
                    reason="wall_clock",
                    iteration=iteration,
                )
                return

            if iteration == max_iterations:
                # Reached only by a conversation that asked for a tool on every single turn.
                yield self._refuse(
                    totals,
                    "AI_TOOL_LOOP_LIMIT",
                    "This request needed more look-ups than are allowed in one exchange and "
                    "was stopped. Ask for one thing at a time.",
                    reason="iteration_cap",
                    iteration=iteration,
                )
                return

            calls: tuple[ToolCall, ...] = ()
            turn_text: list[str] = []
            async for provider_event in self._provider.stream(
                CompletionRequest(
                    messages=messages,
                    tools=prepared.tools,
                    max_output_tokens=self._settings.ai_max_output_tokens,
                )
            ):
                if isinstance(provider_event, TextDelta):
                    turn_text.append(provider_event.text)
                    answer_parts.append(provider_event.text)
                    yield event("delta", {"text": provider_event.text})
                elif isinstance(provider_event, ToolCallsRequested):
                    calls = provider_event.calls
                elif isinstance(provider_event, TurnComplete):
                    _add_usage(totals, provider_event.usage)

            if not calls:
                return

            # The assistant turn is replayed with the text it produced *on this turn* as well as
            # the calls. Dropping the text loses the model's own reasoning about why it reached
            # for a tool, which some providers require in order to continue the turn at all.
            messages.append(
                Message(role="assistant", content="".join(turn_text), tool_calls=calls)
            )

            for call in calls:
                if time.monotonic() > deadline:
                    yield self._refuse(
                        totals,
                        "AI_TIME_LIMIT",
                        "This request took too long and was stopped. Try asking for something "
                        "narrower - a single class, or a shorter date range.",
                        reason="wall_clock_before_tool",
                        iteration=iteration,
                    )
                    return

                async for frame in self._invoke(
                    auth, prepared, call, messages, totals, tool_calls_made
                ):
                    yield frame

    async def _invoke(
        self,
        auth: CallerAuth,
        prepared: PreparedChat,
        call: ToolCall,
        messages: list[Message],
        totals: _Totals,
        tool_calls_made: list[dict[str, Any]],
    ) -> AsyncIterator[bytes]:
        allowed = {tool.name for tool in prepared.tools}
        if call.name not in allowed:
            # Not called. Reported to the model as a refusal so it can say so to the person,
            # rather than retried against the API as a 403 for the security log to absorb.
            logger.warning(
                "model asked for a tool outside the caller's manifest",
                extra={"tool": call.name},
            )
            yield event("tool", {"name": call.name, "status": "refused"})
            messages.append(
                _tool_message(
                    call,
                    prepared.nonce,
                    {"error": "This tool is not available to you.", "tool": call.name},
                )
            )
            return

        yield event("tool", {"name": call.name, "status": "started"})
        totals.tool_calls += 1

        try:
            result = await self._api.invoke_tool(auth, call.name, call.arguments)
        except UpstreamAuthError:
            # An authorization refusal is the caller's answer and ends the exchange, carried
            # back verbatim by `stream`. It is not softened into "the look-up failed": the
            # person asked for something they may not have, and they should be told that.
            raise
        except (UpstreamClientError, UpstreamError) as error:
            # Anything else - a bad argument the model invented, a report that timed out - is
            # reported to the model as a failed tool rather than as the end of the exchange. The
            # answer may still be reachable through the other tools, and "the timetable service
            # is not responding" is a useful thing for a person to be told.
            detail = error.context if isinstance(error, UpstreamError) else {"status": error.status}
            logger.warning("tool invocation failed", extra={"tool": call.name, **detail})
            yield event("tool", {"name": call.name, "status": "failed"})
            messages.append(
                _tool_message(
                    call, prepared.nonce, {"error": "This look-up failed.", "tool": call.name}
                )
            )
            return

        for citation in _extract_citations(result):
            if citation not in totals.citations:
                totals.citations.append(citation)

        tool_calls_made.append(
            {"id": call.id, "name": call.name, "arguments": call.arguments}
        )
        messages.append(
            _tool_message(
                call, prepared.nonce, result, limit=self._settings.ai_max_tool_result_chars
            )
        )
        yield event("tool", {"name": call.name, "status": "completed"})

    # -- helpers -------------------------------------------------------------------------

    def _refuse(self, totals: _Totals, code: str, message: str, **context: Any) -> bytes:
        totals.refused = True
        logger.warning("chat refused", extra={"code": code, **context})
        return event(
            "error",
            {"error": {"code": code, "message": message, "requestId": current_request_id()}},
        )

    async def _persist(
        self,
        auth: CallerAuth,
        conversation_id: str,
        prepared: PreparedChat,
        answer: str,
        tool_calls_made: list[dict[str, Any]],
        totals: _Totals,
    ) -> bool:
        """
        Store the exchange through `apps/api`.

        The **raw** user message is persisted, not the enveloped form. The envelope is a prompt
        artefact with a nonce that is meaningless five minutes later; storing it would make the
        conversation unreadable to the person whose conversation it is.

        A persistence failure does not fail the exchange - the answer has already been streamed,
        and pretending otherwise would be a lie about what the reader just saw. It is logged and
        reported in the `done` event so a client can tell the user their history may be
        incomplete.
        """
        payload: list[dict[str, Any]] = [
            {"role": "user", "content": prepared.user_message},
            {
                "role": "assistant",
                "content": answer,
                "toolCalls": tool_calls_made,
                "citations": totals.citations,
                "provider": self._provider.key,
                "model": self._provider.model,
                "usage": {
                    "inputTokens": totals.input_tokens,
                    "outputTokens": totals.output_tokens,
                },
            },
        ]
        try:
            await self._api.append_messages(auth, conversation_id, payload)
        except (UpstreamRefusal, UpstreamError) as error:
            logger.error(
                "failed to persist the exchange",
                extra={"conversationId": conversation_id},
                exc_info=error,
            )
            return False
        return True


def _add_usage(totals: _Totals, usage: Usage) -> None:
    totals.input_tokens += usage.input_tokens
    totals.output_tokens += usage.output_tokens


def _tool_message(
    call: ToolCall, nonce: str, payload: Any, *, limit: int | None = None
) -> Message:
    """
    A tool result, wrapped as untrusted data.

    A tool result is not trustworthy just because it arrived over an authenticated channel. A
    knowledge-base chunk is a document somebody uploaded and a student remark is text somebody
    typed; both reach the model through a tool, and both can contain an instruction addressed to
    it. Provenance is not authorship (docs/06 section 3).
    """
    text = json.dumps(payload, ensure_ascii=False, default=str)
    if limit is not None and len(text) > limit:
        # Truncation is announced inside the payload rather than done silently, so the model
        # does not summarise a cut-off list as if it were complete.
        text = text[:limit] + '…"[truncated: the result was too large to include in full]"'
    return Message(
        role="tool",
        content=wrap_as_data(text, label=f"tool-result:{call.name}", nonce=nonce),
        tool_call_id=call.id,
        tool_name=call.name,
    )


def _extract_citations(result: Any) -> list[dict[str, Any]]:
    """
    Pull citations out of a tool result, wherever the tool put them.

    Only ever *copied* - never synthesised. An answer whose citations were invented by the
    gateway would look grounded and not be, which is worse than an answer with none
    (docs/06 section 5).
    """
    found: list[dict[str, Any]] = []
    for container in _citation_containers(result):
        for entry in container:
            if isinstance(entry, dict):
                found.append(entry)
    return found


def _citation_containers(result: Any) -> Sequence[list[Any]]:
    if not isinstance(result, dict):
        return []
    containers: list[list[Any]] = []
    for key in ("citations", "sources"):
        value = result.get(key)
        if isinstance(value, list):
            containers.append(value)
    # Tools that wrap their payload - `{"result": {...}}` or `{"data": {...}}` - are common
    # enough that not looking one level down would silently lose every citation.
    for wrapper in ("result", "data"):
        nested = result.get(wrapper)
        if isinstance(nested, dict):
            for key in ("citations", "sources"):
                value = nested.get(key)
                if isinstance(value, list):
                    containers.append(value)
    return containers


def _auth_refusal_payload(refusal: UpstreamRefusal) -> dict[str, Any]:
    """The API's refusal, unchanged, in a shape an SSE consumer can read."""
    try:
        body = json.loads(refusal.raw_body or b"{}")
    except ValueError:
        body = {}
    payload: dict[str, Any] = {"status": refusal.status}
    if isinstance(body, dict) and "error" in body:
        payload["error"] = body["error"]
    else:
        payload["error"] = {
            "code": "FORBIDDEN" if refusal.status == 403 else "UNAUTHENTICATED",
            "message": "You are not allowed to do that.",
        }
    return payload
