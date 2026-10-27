import os
from pathlib import Path
import pytest

@pytest.fixture(scope='session')
def service_root():
    return Path(__file__).resolve().parents[1]

from testsuite.databases.pgsql import discover
pytest_plugins=['libs.testing.pytest_plugin','testsuite.pytest_plugin','testsuite.databases.pgsql.pytest_plugin']

@pytest.fixture(scope='session')
def pgsql_local(service_root,pgsql_local_create):
    return pgsql_local_create(list(discover.find_schemas('solo_auth',[service_root/'tests/schemas']).values()))

@pytest.fixture(scope='session')
async def service_daemon(create_daemon_scope,pgsql_local,hmac_file,tmp_path_factory):
    dsn_file=tmp_path_factory.mktemp('config')/'database-url'
    dsn_file.write_text(pgsql_local['authdb'].get_dsn()+" connect_timeout=2 target_session_attrs=read-write options='-c statement_timeout=7000 -c lock_timeout=3000'")
    dsn_file.chmod(0o600)
    env={**os.environ,'DB_POOL_MAX_CONNECTIONS':'2','DB_POOL_MAX_LIFETIME_SECONDS':'3','HEALTH_COOLDOWN_SECONDS':'2','PORT':'18082','LISTEN_ADDRESS':'127.0.0.1','DATABASE_URL_FILE':str(dsn_file),'HMAC_KEY_FILE':str(hmac_file)}
    async with create_daemon_scope(args=[os.environ['SERVICE_BINARY']],env=env,ping_url='http://127.0.0.1:18082/healthz') as scope:
        yield scope

@pytest.fixture
async def service_client(ensure_daemon_started,create_service_client,service_daemon,pgsql):
    await ensure_daemon_started(service_daemon)
    return create_service_client('http://127.0.0.1:18082/')
