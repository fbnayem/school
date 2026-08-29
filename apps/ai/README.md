# apps/ai — the AI gateway

FastAPI service that assembles prompts, routes them to an inference provider, and runs the
tool-call loop on behalf of one signed-in person.

---

## The rule that shapes everything else

**This service is given no database credentials. Not restricted ones. None.**

It reaches institutional data only by calling back into `apps/api` with the **caller's own
bearer token**, so every read and every write is re-authenticated and re-authorized by the
trusted service against that person's permissions. It cannot fetch anything the person talking
to it could not fetch themselves, because it has no other identity to fetch it with.

This is deliberately structural rather than procedural. "The AI must not bypass permissions" as
a policy is something a prompt injection can talk its way around. As a missing driver and a
missing connection string, it is not. Three things enforce it:

| Where                              | What                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `pyproject.toml`                   | no driver, no ORM, no cache client — in the declared **or** the resolved set  |
| `app/guards.py`                    | the process **refuses to start** if the environment holds a connection string |
| `tests/test_no_database_driver.py` | fails the build the day someone adds one, transitively included               |

If that test ever fails, the answer is not to extend a list. The answer is that the work being
attempted belongs in `apps/api`, behind a permission and an audit row.

See `docs/06_AI_ARCHITECTURE.md` §1 and `docs/07_SECURITY_MODEL.md` §1.

---

## Endpoints

### `POST /chat`

Headers: `Authorization: Bearer <the caller's access token>`, `X-Institution-Id`, optional
`X-Request-Id`.

The gateway treats `X-Institution-Id` as optional and simply forwards it, because it is not the
gateway's business which routes are institution-scoped. In practice the API's `/ai/*` routes are
`@InstitutionScoped()`, so omitting it earns a 400 from the API — which reaches the caller
intact, guidance and all, rather than being masked.

```json
{ "conversationId": "0192f5a0-…", "message": "How is attendance in class 6B?" }
```

What it does, in order:

1. `GET {AI_API_BASE_URL}/{AI_API_PREFIX}/ai/tools` **with the caller's token**, for the
   manifest of tools this specific person may use.
2. Assembles the prompt: system instructions, then that manifest, then the person's message
   inside a labelled, nonce-delimited data envelope. User content is never concatenated into
   the instruction section.
3. Runs the model loop, calling `POST …/ai/tools/{name}/invoke` with the caller's token for each
   tool call and feeding results back as `role: "tool"` messages — themselves enveloped, because
   an uploaded document is not trustworthy just because it arrived over an authenticated
   channel.
4. Persists the exchange with `POST …/ai/conversations/{id}/messages`, sending a `messages`
   array of two turns: the raw user turn, then the assistant turn with its tool calls,
   citations and token usage. The **raw** message is stored, never the enveloped form — the
   envelope is a prompt artefact with a nonce that is meaningless five minutes later, and
   storing it would make the conversation unreadable to the person whose conversation it is.
5. Streams the answer as SSE, with citations where a knowledge tool supplied them.

Persistence is best-effort **by design**: the answer has already been streamed by the time it
runs, and failing the exchange afterwards would be a lie about what the reader just saw. A
failure is logged and reported as `"persisted": false` in the `done` event, so a client can warn
that the history may be incomplete.

Returns `text/event-stream`. Event names:

| Event       | Payload                                                           |
| ----------- | ----------------------------------------------------------------- |
| `meta`      | `conversationId`, `requestId`, `provider`, `model`, `tools`       |
| `delta`     | `{"text": "…"}` — a fragment of the answer                        |
| `tool`      | `{"name": "…", "status": "started\|completed\|failed\|refused"}`  |
| `citations` | `{"citations": [...]}` — copied from tool results, never invented |
| `usage`     | token counts and the tool-call count                              |
| `error`     | the standard `{"error": {...}}` envelope                          |
| `done`      | `{"ok": bool, "persisted": bool}` — always last                   |

**Refusals from `apps/api` are passed through unchanged.** Every 4xx reaches the caller with the
same status and the same body, byte for byte — 401 and 403 above all, and those are **never
retried**: a retry would need different credentials, and this process has none. A refusal that
arrives before the stream opens is a real HTTP status; one that arrives mid-stream is an `error`
event carrying the same code, because the status line is already spent.

A 5xx is the opposite case and is **not** passed through. An upstream error message can carry a
stack trace or a SQL fragment, so it becomes a generic 502 with the detail in the log
(docs/07 §6).

One exception, and it is deliberate: a 4xx on a **tool call** mid-loop is reported back to the
model as a failed tool rather than ending the exchange, because a rejected argument is the
model's mistake and the answer may still be reachable. A 401/403 on a tool call is not — that is
the person's answer, and they should be told it.

**The loop is capped**, by iterations (`AI_MAX_TOOL_ITERATIONS`) and by wall clock
(`AI_MAX_WALL_CLOCK_SECONDS`). Reaching either refuses the exchange with `AI_TOOL_LOOP_LIMIT` or
`AI_TIME_LIMIT` rather than continuing. An injected prompt that induces an endless tool loop is
a denial-of-service attack against the school's own inference budget, and schools here are on
fixed subscriptions.

### `GET /healthz`

Liveness. Reports the configured provider and **whether** its credentials are present — never
which variable is missing, and never any part of a key. An unauthenticated health endpoint is a
reconnaissance surface. The missing variable's name is in the startup log instead.

### `GET /readyz`

Readiness. Verifies it can reach `apps/api`'s public liveness route. 503 when it cannot: without
the API this service has no source of data and no source of authorization.

---

## What the AI must never do

`app/prompt.py` carries the instruction, and there is no code path that could carry it out
anyway: the gateway has no mutating tool of its own, and every tool it can call is an
`apps/api` endpoint with its own permission check. AI never autonomously changes a grade or an
attendance record, approves an admission, decides a punishment, issues a refund, changes a
salary, runs payroll, creates an accounting entry, deletes a record, or sends a sensitive mass
communication.

The pattern is **AI suggests → a human reviews → a human confirms → the system executes**, where
the confirmation is a normal permission-checked, audited API call made by that human.
`audit_logs.is_ai_initiated` is what keeps an AI-assisted action distinguishable in the trail
years later.

---

## Environment variables

| Variable                         | Default                                     | Meaning                                        |
| -------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| `AI_ENVIRONMENT`                 | `development`                               | `development` \| `test` \| `production`        |
| `AI_PORT`                        | `8000`                                      | Listen port                                    |
| `AI_HOST`                        | `0.0.0.0`                                   | Bind address                                   |
| `AI_LOG_LEVEL`                   | `info`                                      | `fatal`…`trace`, or `silent`                   |
| `AI_SERVICE_NAME`                | `shikkha-ai`                                | The `service` field in every log line          |
| `AI_API_BASE_URL`                | `http://localhost:4000`                     | Where `apps/api` lives                         |
| `AI_API_PREFIX`                  | `api/v1`                                    | The API's versioned route prefix               |
| `AI_API_TIMEOUT_SECONDS`         | `20`                                        | Per delegated call                             |
| `AI_API_CONNECT_TIMEOUT_SECONDS` | `5`                                         | Connect phase only                             |
| `AI_PROVIDER`                    | `mock`                                      | `mock` \| `openai` \| `anthropic` \| `gemini`  |
| `AI_MODEL`                       | adapter default                             | Overrides the adapter's model id               |
| `AI_MAX_OUTPUT_TOKENS`           | `4096`                                      | Per model turn                                 |
| `AI_MAX_TOOL_ITERATIONS`         | `6`                                         | Hard cap on model turns in one exchange (1–20) |
| `AI_MAX_WALL_CLOCK_SECONDS`      | `45`                                        | Hard cap on one exchange                       |
| `AI_MAX_MESSAGE_CHARS`           | `8000`                                      | Largest accepted message                       |
| `AI_MAX_TOOL_RESULT_CHARS`       | `20000`                                     | Largest tool result fed back into the prompt   |
| `AI_CORS_ORIGINS`                | _(empty)_                                   | Comma-separated. No wildcard in production     |
| `OPENAI_API_KEY`                 | —                                           | Required when `AI_PROVIDER=openai`             |
| `OPENAI_BASE_URL`                | `https://api.openai.com/v1`                 | Also drives an OpenAI-compatible local server  |
| `ANTHROPIC_API_KEY`              | —                                           | Required when `AI_PROVIDER=anthropic`          |
| `ANTHROPIC_BASE_URL`             | `https://api.anthropic.com`                 |                                                |
| `ANTHROPIC_VERSION`              | `2023-06-01`                                | The `anthropic-version` header                 |
| `GEMINI_API_KEY`                 | —                                           | Required when `AI_PROVIDER=gemini`             |
| `GEMINI_BASE_URL`                | `https://generativelanguage.googleapis.com` |                                                |

**Refused in production:** `AI_PROVIDER=mock` (it fabricates answers, and a fabricated sentence
about a child is worse than an outage) and a wildcard in `AI_CORS_ORIGINS`.

**Refused everywhere:** any variable that looks like a database connection — by name
(`DATABASE_URL`, `DB_DSN`, `PGHOST`, `REDIS_URL`, …) or by value (anything starting
`postgres://`, `mysql://`, `mongodb://`, `redis://`, …). The process will not start, and the
crash message names the offending variables but never their values.

---

## Providers

| Key         | Credentials         | Notes                                                                    |
| ----------- | ------------------- | ------------------------------------------------------------------------ |
| `mock`      | none                | Deterministic. Labels every answer `[mock provider …]`. Refused in prod. |
| `openai`    | `OPENAI_API_KEY`    | Chat Completions, streaming, `stream_options.include_usage`              |
| `anthropic` | `ANTHROPIC_API_KEY` | Messages API, streaming. Default model `claude-opus-5`                   |
| `gemini`    | `GEMINI_API_KEY`    | `streamGenerateContent?alt=sse`. Key in a header, not the query string   |

A provider selected without its key is still constructed and still registered, and **refuses
every request loudly** — naming the missing variable in the log and never in the client-facing
message. It never falls back to `mock`: a silent fallback would give a school invented answers
with no signal at all, which is worse than both the outage and the loud refusal. This is the
same pattern as `apps/api/src/modules/transport/providers/stub-gps.provider.ts`.

The adapters speak the vendors' HTTP APIs over `httpx` rather than pulling in `openai`,
`anthropic` and `google-genai`. Each SDK drags in a transitive tree nobody audits, and the point
of this service's dependency list is that it is short enough to read — see the top of
`pyproject.toml`. The non-Anthropic default model ids are a starting point, not a promise: check
them against the vendor's current catalogue and pin with `AI_MODEL`.

---

## Logging

Structured JSON on stdout, with the field names `apps/api` uses — `time`, `level`, `service`,
`env`, `requestId`, `msg` — so one request that crosses both services produces one correlatable
trace. An inbound `x-request-id` is accepted if it matches the API's charset rule
(`[A-Za-z0-9_.:-]{1,64}`) and generated as a UUIDv7 otherwise; it is echoed on the response and
forwarded on every delegated call.

Credentials and personal data are redacted at serialisation time, mirroring the API's pino
redaction list. A log aggregator is a far softer target than the database.

---

## Development

```bash
cd apps/ai
python -m venv .venv && . .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -e ".[dev]"

cp .env.example .env
uvicorn app.main:create_app --factory --reload --port 8000
```

With `AI_PROVIDER=mock` and `apps/api` running, `POST /chat` works end to end with no
credentials of any kind.

```bash
pytest          # 79 tests, no network: apps/api and every vendor go through httpx.MockTransport
ruff check .
mypy
```

There is no module-level `app` object — `--factory` is required. That keeps the
database-credential assertion and the settings parse inside a call the test suite can make with
its own environment, rather than at import time.

### Open integration point

`POST /api/v1/ai/conversations/{id}/messages` is, as of this writing, implemented on the API
side as a **self-contained completion** endpoint: it takes `{"content": "…"}`, runs its own
provider and writes both turns itself. This gateway calls it as a **persistence** endpoint, with
`{"messages": [...]}`, per its own specification.

The two shapes do not currently agree, so persistence will be rejected with a 400 until one side
moves. That degrades safely and visibly rather than silently: `/chat` still answers, still
streams, still calls tools, and the `done` event reports `"persisted": false`. Sending
`{"content": …}` instead was considered and rejected — it would make the API run a _second_
inference for an answer this gateway has already produced, and bill the school twice for it.

Resolving it is one decision, not a code change here: either the API grows a persistence-only
shape for a caller that has already produced the answer, or `/chat` is removed in favour of the
API's own completion route. Everything else in this service already matches its counterpart —
the manifest is `{tools: [{name, description, parameters}]}`, an invocation takes
`{arguments: {...}}` and returns `{tool, arguments, result, citations?}`, and the citation
extraction reads exactly that.

### Note for the developer running the Node side too

If your shell exports `DATABASE_URL` for `apps/api`, this service will refuse to start in that
shell. That is the guard doing its job. Run it in a clean shell, or from Docker Compose where
each service gets its own environment block.
