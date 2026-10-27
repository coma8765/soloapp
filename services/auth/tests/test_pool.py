import asyncio


def connections(pgsql):
    with pgsql['authdb'].cursor() as cur:
        cur.execute("SELECT pid FROM pg_stat_activity WHERE application_name='soloapp-auth'")
        return {row[0] for row in cur.fetchall()}


async def test_pool_reuses_connections(service_client, pgsql):
    assert (await service_client.get('/ready')).status_code == 200
    before = connections(pgsql)
    assert before
    for _ in range(12):
        assert (await service_client.get('/ready')).status_code == 200
    assert connections(pgsql) == before


async def test_pool_bounds_concurrent_connections(service_client, pgsql):
    responses = await asyncio.gather(*(service_client.get('/ready') for _ in range(24)))
    assert all(response.status_code == 200 for response in responses)
    assert 1 <= len(connections(pgsql)) <= 2


async def test_pool_reconnects_terminated_backends(service_client, pgsql):
    assert (await service_client.get('/ready')).status_code == 200
    before = connections(pgsql)
    with pgsql['authdb'].cursor() as cur:
        for pid in before:
            cur.execute('SELECT pg_terminate_backend(%s)', (pid,))
    # A failed checkout can fail this request; subsequent requests must recover.
    for _ in range(3):
        await service_client.get('/ready')
    assert (await service_client.get('/ready')).status_code == 200
    assert connections(pgsql).isdisjoint(before)


async def test_pool_recycles_after_lifetime(service_client, pgsql):
    assert (await service_client.get('/ready')).status_code == 200
    before = connections(pgsql)
    await asyncio.sleep(3.2)
    assert (await service_client.get('/ready')).status_code == 200
    # Idle connections are recycled on checkout, never during an active transaction.
    assert connections(pgsql) - before


def test_pool_replaces_read_only_connection(pgsql_local):
    import os
    import subprocess
    from pathlib import Path
    result = subprocess.run(
        [str(Path(os.environ['SERVICE_BINARY']).with_name('auth-pool-probe'))],
        env={**os.environ, 'PGPOOL_TEST_DSN': pgsql_local['authdb'].get_dsn()},
        text=True, capture_output=True, timeout=10,
    )
    assert result.returncode == 0, result.stdout
    assert result.stdout.strip() == 'replaced-read-only-connection'
