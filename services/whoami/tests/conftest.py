import os
from pathlib import Path
import pytest

@pytest.fixture(scope='session')
def service_root():
    return Path(__file__).resolve().parents[1]

pytest_plugins=['libs.testing.pytest_plugin','testsuite.pytest_plugin']

@pytest.fixture(scope='session')
async def service_daemon(create_daemon_scope,hmac_file):
    env={**os.environ,'PORT':'18081','LISTEN_ADDRESS':'127.0.0.1','HMAC_KEY_FILE':str(hmac_file)}
    async with create_daemon_scope(args=[os.environ['SERVICE_BINARY']],env=env,ping_url='http://127.0.0.1:18081/user-id',ping_response_codes=(401,)) as scope:
        yield scope

@pytest.fixture
async def service_client(ensure_daemon_started,create_service_client,service_daemon):
    await ensure_daemon_started(service_daemon)
    return create_service_client('http://127.0.0.1:18081/')
