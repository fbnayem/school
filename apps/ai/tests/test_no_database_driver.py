"""
The test that stops someone innocently adding an ORM in two years.

`apps/ai` sits in the untrusted band by construction (docs/07 section 1): it reaches
institutional data only by calling back into `apps/api` with the caller's delegated
authorization, and the reason a prompt injection cannot talk its way past that is that there is
no other path. Not a discouraged path - no path.

A policy decays. A dependency does not. So the property is asserted four ways, from the most
specific to the most general:

  1. `pyproject.toml` declares no driver - catches the addition at review time.
  2. Nothing driver-shaped is installed in the resolved environment - catches a driver arriving
     transitively, under a name nobody read.
  3. Nothing driver-shaped is importable - catches a vendored copy on the path.
  4. No module under `app/` imports one - catches the case where all three above are somehow
     satisfied and the code reaches for it anyway.

If this test ever fails, the answer is not to add the name to a list. The answer is that the
work being attempted belongs in `apps/api`, behind a permission and an audit row.
"""

from __future__ import annotations

import importlib.metadata
import importlib.util
import pathlib
import re
import sys
import tomllib

APP_ROOT = pathlib.Path(__file__).resolve().parent.parent

# Distribution names. Anything that can open a connection to a data store, plus the ORMs and
# migration tools that imply one.
FORBIDDEN_DISTRIBUTIONS = frozenset(
    {
        "psycopg",
        "psycopg2",
        "psycopg2-binary",
        "psycopg-binary",
        "psycopg-c",
        "psycopg-pool",
        "asyncpg",
        "pg8000",
        "aiopg",
        "sqlalchemy",
        "sqlmodel",
        "alembic",
        "databases",
        "peewee",
        "tortoise-orm",
        "piccolo",
        "django",
        "pony",
        "pymysql",
        "mysqlclient",
        "aiomysql",
        "mysql-connector-python",
        "pymongo",
        "motor",
        "beanie",
        # Redis holds queued jobs and session material in this system, which puts it on the
        # same side of the trust boundary as the database.
        "redis",
        "aioredis",
        "valkey",
        "pgvector",
        "supabase",
        "prisma",
    }
)

# Import names, which do not always match the distribution name.
FORBIDDEN_MODULES = frozenset(
    {
        "psycopg",
        "psycopg2",
        "asyncpg",
        "sqlalchemy",
        "sqlmodel",
        "alembic",
        "aiopg",
        "pg8000",
        "peewee",
        "tortoise",
        "django",
        "pymysql",
        "aiomysql",
        "MySQLdb",
        "pymongo",
        "motor",
        "redis",
        "aioredis",
        "sqlite3",
        "prisma",
    }
)


def _normalise(name: str) -> str:
    """PEP 503 normalisation, so `Psycopg2_Binary` and `psycopg2-binary` compare equal."""
    return re.sub(r"[-_.]+", "-", name).lower()


def test_pyproject_declares_no_database_driver() -> None:
    manifest = tomllib.loads((APP_ROOT / "pyproject.toml").read_text(encoding="utf-8"))
    project = manifest["project"]

    declared: list[str] = list(project.get("dependencies", []))
    for group in project.get("optional-dependencies", {}).values():
        declared.extend(group)

    offenders = []
    for requirement in declared:
        # `name[extra]==1.2.3` -> `name`
        name = re.split(r"[<>=!~\[; ]", requirement, maxsplit=1)[0]
        if _normalise(name) in {_normalise(item) for item in FORBIDDEN_DISTRIBUTIONS}:
            offenders.append(requirement)

    assert offenders == [], (
        "apps/ai declares a database driver or ORM: "
        f"{offenders}. This service must have no path to the database; the work belongs in "
        "apps/api behind a permission and an audit row. See docs/07 section 1."
    )


def test_no_database_driver_is_installed() -> None:
    """Walk the resolved dependency set, not the declared one."""
    installed = set()
    for distribution in importlib.metadata.distributions():
        name = distribution.metadata["Name"]
        if name:
            installed.add(_normalise(name))

    offenders = sorted(installed & {_normalise(item) for item in FORBIDDEN_DISTRIBUTIONS})

    assert offenders == [], (
        "a database driver or ORM has entered the resolved dependency set: "
        f"{offenders}. It may have arrived transitively. Find what pulled it in "
        "(`pip tree` / `uv pip tree`) and remove that dependency rather than this assertion."
    )


def test_no_database_driver_is_importable() -> None:
    """
    A driver present on the path but not installed as a distribution still opens a connection.

    `sqlite3` is in the list even though it ships with CPython: this service has no business
    holding a local database either, and an on-disk cache of school records in the untrusted
    band would be a breach with extra steps.
    """
    importable = []
    for module in sorted(FORBIDDEN_MODULES):
        if module in sys.modules:
            importable.append(module)
            continue
        try:
            spec = importlib.util.find_spec(module)
        except (ImportError, ValueError):  # pragma: no cover - malformed path entry
            continue
        # A stdlib module being *findable* is unavoidable; being *imported* is not.
        if spec is not None and module != "sqlite3":
            importable.append(module)

    assert importable == [], (
        f"a database client is importable from this environment: {importable}"
    )


def test_no_module_under_app_imports_a_driver() -> None:
    names = "|".join(re.escape(module) for module in sorted(FORBIDDEN_MODULES))
    pattern = re.compile(rf"^\s*(?:import|from)\s+({names})\b", re.MULTILINE)
    offenders = []
    for path in sorted((APP_ROOT / "app").rglob("*.py")):
        if pattern.search(path.read_text(encoding="utf-8")):
            offenders.append(str(path.relative_to(APP_ROOT)))

    assert offenders == [], f"a module under app/ imports a database client: {offenders}"
