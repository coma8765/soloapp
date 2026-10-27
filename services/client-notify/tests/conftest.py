import json
import os
from pathlib import Path

import pytest
from testsuite.databases.pgsql import discover

pytest_plugins = ["testsuite.pytest_plugin", "testsuite.databases.pgsql.pytest_plugin"]


@pytest.fixture(scope="session")
def pgsql_local(pgsql_local_create):
    return pgsql_local_create(
        list(discover.find_schemas("solo_notify", [Path(__file__).parent / "schemas"]).values())
    )


@pytest.fixture(scope="session")
async def service_daemon(create_daemon_scope, pgsql_local, tmp_path_factory, mockserver_info):
    directory = tmp_path_factory.mktemp("notify-config")
    dsn = directory / "dsn"
    dsn.write_text(
        pgsql_local["notifydb"].get_dsn()
        + " connect_timeout=2 target_session_attrs=read-write options='-c statement_timeout=4000 -c lock_timeout=2000'"
    )
    token = directory / "api-token"
    token.write_text("synthetic-notify-test-token")
    config = directory / "config.json"
    config.write_text(
        json.dumps(
            {
                "rabbitmq": {
                    "host": os.environ.get("RABBIT_HOST", "127.0.0.1"),
                    "port": 5672,
                    "tls": False,
                    "user": "notifytest",
                    "password": "synthetic-local-only",
                    "queue": "client-notify",
                },
                "gateway": {
                    "url": mockserver_info.base_url.rstrip("/"),
                    "token": "synthetic-gateway-test",
                },
                "delivery_timeout_ms": 10000,
                "ack_timeout_ms": 30000,
                "retry_delay_ms": 1000,
            }
        )
    )
    for path in (dsn, token, config):
        path.chmod(0o600)
    env = {
        **os.environ,
        "DATABASE_URL_FILE": str(dsn),
        "NOTIFY_API_TOKEN_FILE": str(token),
        "NOTIFY_CONFIG_FILE": str(config),
        "NOTIFY_TEST_ALLOW_PLAINTEXT": "1",
        "LISTEN_ADDRESS": "127.0.0.1",
        "PORT": "18086",
    }
    async with create_daemon_scope(
        args=[os.environ["SERVICE_BINARY"]], env=env, ping_url="http://127.0.0.1:18086/healthz"
    ) as scope:
        yield scope


@pytest.fixture
async def service_client(ensure_daemon_started, create_service_client, service_daemon, pgsql):
    await ensure_daemon_started(service_daemon)
    return create_service_client("http://127.0.0.1:18086/")
