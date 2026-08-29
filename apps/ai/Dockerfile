# apps/ai — the AI gateway.
#
# The image deliberately contains no database client, and the runtime environment must contain
# no connection string: `app/guards.py` refuses to start if one is present. That refusal is the
# security property described in docs/07 §1, so if this container ever fails to boot with a
# "database credentials" message, the fix is to remove the variable from the deployment — never
# to relax the check.

FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv/ai

# Dependencies first, in their own layer: the source changes far more often than the pins, and
# `pyproject.toml` alone is enough to resolve them.
COPY pyproject.toml README.md ./
COPY app ./app
RUN pip install --no-cache-dir .

# Runs as a non-root user with no shell. A gateway that holds a stream of other people's bearer
# tokens should not also hold root in its own container.
RUN useradd --create-home --shell /usr/sbin/nologin --uid 10001 shikkha \
    && chown -R shikkha:shikkha /srv/ai
USER shikkha

EXPOSE 8000

# Liveness only — no dependency check. A liveness probe that pings apps/api restarts every
# gateway container during a brief API blip and turns a degradation into an outage.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2).status == 200 else 1)"]

# `--factory`: there is no module-level application object, so that the startup assertion and
# the settings parse happen inside a call rather than at import time.
CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
