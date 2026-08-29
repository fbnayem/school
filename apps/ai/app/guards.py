"""
The startup assertion that keeps this service out of the database.

docs/06 §1 and docs/07 §1 both state the same thing: `apps/ai` is given no database
credentials, and that is why a prompt injection cannot make it read another tenant's rows. The
property only holds if it is true of the *running process*, not of the deployment manifest that
was reviewed six months ago, so the process checks its own environment before it serves a
request.

Finding a connection string here is not a configuration preference to be tolerated — it means
someone copied the API's environment block, or a compose file grew a shared `env_file`, and the
untrusted band now holds trusted credentials. That deployment must not be allowed to start.

Two things are deliberate:

  * The check reports variable **names only**. A connection string contains a password, and
    this function's output goes to a log and a crash message.
  * There is no allow-list and no override flag. An escape hatch here would be used, once, in
    an incident, and would then stay.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping

__all__ = [
    "DatabaseCredentialsPresentError",
    "assert_no_database_credentials",
    "find_database_credentials",
]

# Names that mean "a database lives at the other end of this". The prefix list covers the
# engines this system uses or might plausibly be pointed at; Redis is on it because in Shikkha
# it holds queued jobs and session material, which is the same side of the trust boundary.
_FORBIDDEN_NAME = re.compile(
    r"""
    ^(?:.*_)?
    (?:DATABASE|DB|POSTGRES|POSTGRESQL|PG|MYSQL|MARIADB|MONGO|MONGODB|REDIS|VALKEY)
    _?
    (?:URL|URI|DSN|CONNECTION|CONNECTIONSTRING|CONNECTION_STRING|PASSWORD|PASSWD|
       USER|USERNAME|HOST|HOSTNAME|DATABASE|NAME|PORT)
    $
    """,
    re.VERBOSE,
)

# The libpq family does not follow the pattern above (`PGHOST`, not `PG_HOST`).
_FORBIDDEN_EXACT = frozenset(
    {
        "PGDATA",
        "PGHOST",
        "PGPORT",
        "PGUSER",
        "PGPASSWORD",
        "PGPASSFILE",
        "PGDATABASE",
        "PGSERVICE",
        "PGSSLMODE",
        "PGCONNECT_TIMEOUT",
    }
)

# A variable can be named anything and still be a connection string. Checking the *value* for a
# database URL scheme catches the case a name list never will: `AI_CACHE=redis://…`, or a
# helpfully-renamed `SHIKKHA_STORE=postgres://…`.
_FORBIDDEN_VALUE_SCHEMES = (
    "postgres://",
    "postgresql://",
    "postgresql+",
    "mysql://",
    "mysql+",
    "mariadb://",
    "mongodb://",
    "mongodb+srv://",
    "redis://",
    "rediss://",
    "valkey://",
    "sqlite://",
)


class DatabaseCredentialsPresentError(RuntimeError):
    """Raised at startup when the environment carries database credentials."""

    def __init__(self, names: list[str]) -> None:
        self.names = names
        super().__init__(
            "apps/ai found database credentials in its environment: "
            + ", ".join(names)
            + ". This service must have none — it reaches institutional data only by calling "
            "back into apps/api with the caller's own authorization (docs/07 §1). A connection "
            "string here means a deployment mistake, most often the API's environment block "
            "copied onto this service. Remove the variables; do not add an exemption."
        )


def find_database_credentials(environ: Mapping[str, str] | None = None) -> list[str]:
    """
    Return the names of environment variables that look like database credentials.

    Names only — never values. The caller logs and prints this.
    """
    source = os.environ if environ is None else environ
    offenders: set[str] = set()

    for name, value in source.items():
        upper = name.upper()
        if upper in _FORBIDDEN_EXACT or _FORBIDDEN_NAME.match(upper):
            offenders.add(name)
            continue
        candidate = value.strip().lower()
        if any(candidate.startswith(scheme) for scheme in _FORBIDDEN_VALUE_SCHEMES):
            offenders.add(name)

    return sorted(offenders)


def assert_no_database_credentials(environ: Mapping[str, str] | None = None) -> None:
    """Fail startup if the process holds anything that could open a database connection."""
    offenders = find_database_credentials(environ)
    if offenders:
        raise DatabaseCredentialsPresentError(offenders)
