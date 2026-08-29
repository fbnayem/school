"""
The startup assertion.

The dependency test proves this service *cannot* open a database connection. This one proves it
*refuses to run* if somebody hands it the credentials to try - which is the failure mode that
actually happens: a compose file grows a shared `env_file`, or the API's environment block is
copied onto the gateway during a migration.
"""

from __future__ import annotations

import pytest

from app.guards import (
    DatabaseCredentialsPresentError,
    assert_no_database_credentials,
    find_database_credentials,
)

SAFE_ENVIRONMENT = {
    "AI_PROVIDER": "mock",
    "AI_API_BASE_URL": "http://api:4000",
    "AI_PORT": "8000",
    "ANTHROPIC_API_KEY": "sk-ant-not-a-real-key",
    "PATH": "/usr/local/bin:/usr/bin",
    "HOME": "/home/app",
}


def test_a_clean_environment_starts() -> None:
    assert find_database_credentials(SAFE_ENVIRONMENT) == []
    assert_no_database_credentials(SAFE_ENVIRONMENT)


@pytest.mark.parametrize(
    "name",
    [
        "DATABASE_URL",
        "MIGRATION_DATABASE_URL",
        "SHIKKHA_DATABASE_URL",
        "DB_DSN",
        "POSTGRES_PASSWORD",
        "PGHOST",
        "REDIS_URL",
    ],
)
def test_a_connection_variable_refuses_startup(name: str) -> None:
    environment = {**SAFE_ENVIRONMENT, name: "postgres://user:pw@db:5432/shikkha"}

    with pytest.raises(DatabaseCredentialsPresentError) as raised:
        assert_no_database_credentials(environment)

    assert name in raised.value.names
    # The name is in the message so an operator can act on it; the value is not, because the
    # crash message reaches a log and the value contains a password.
    assert name in str(raised.value)
    assert "pw" not in str(raised.value)


def test_a_connection_string_hidden_under_an_innocent_name_is_caught() -> None:
    """The name list is not the only check - the value is inspected too."""
    environment = {**SAFE_ENVIRONMENT, "AI_CACHE_TARGET": "postgresql://app:secret@db/shikkha"}

    offenders = find_database_credentials(environment)

    assert offenders == ["AI_CACHE_TARGET"]


def test_the_gateways_own_variables_are_not_false_positives() -> None:
    """`AI_API_BASE_URL` and friends must not be mistaken for connection strings."""
    environment = {
        **SAFE_ENVIRONMENT,
        "AI_API_BASE_URL": "http://api:4000",
        "WEB_APP_URL": "https://school.example",
        "OPENAI_BASE_URL": "https://api.openai.com/v1",
        "AI_API_PREFIX": "api/v1",
    }

    assert find_database_credentials(environment) == []


def test_the_error_names_every_offender_at_once() -> None:
    environment = {
        **SAFE_ENVIRONMENT,
        "DATABASE_URL": "postgres://a@db/x",
        "PGPASSWORD": "hunter2",
    }

    with pytest.raises(DatabaseCredentialsPresentError) as raised:
        assert_no_database_credentials(environment)

    # Reporting one at a time turns a single fix into three deploys.
    assert raised.value.names == ["DATABASE_URL", "PGPASSWORD"]
