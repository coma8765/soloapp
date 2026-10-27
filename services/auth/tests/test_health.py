import asyncio
import pytest

@pytest.mark.parametrize('events,check_ms,trips,ready', [
    ([(0, 500), (1, 502), (2, 599)], 3, [False, False, True], False),
    ([(0, 400), (1, 401), (2, 429), (3, 499), (4, 600)], 5, [False]*5, True),
    ([(0, 500), (10000, 503), (10001, 504)], 10002, [False]*3, True),
    ([(0, 500), (1, 200), (2, 503), (3, 500)], 4, [False]*3+[True], False),
    ([(0, 500), (1, 501), (2, 503), (14000, 500)], 15002, [False,False,True,False], True),
    ([(0, 500), (1, 501), (2, 503)], 15001, [False,False,True], False),
    ([(0, 500), (1, 501), (2, 503), (15002, 500), (15003, 502), (15004, 503)], 15005, [False,False,True,False,False,True], False),
])
def test_health_window(unit_probe, events, check_ms, trips, ready):
    result = unit_probe({'command': 'health', 'events': [{'ms': t, 'code': c} for t,c in events], 'check_ms': check_ms})
    assert [s['tripped'] for s in result['states']] == trips
    assert result['ready'] == ready

async def test_http_5xx_excludes_without_failing_liveness(service_client, pgsql):
    assert (await service_client.get('/health/ready')).status_code == 200
    with pgsql['authdb'].cursor() as cur:
        cur.execute('ALTER TABLE users RENAME TO users_health_test')
    try:
        for _ in range(3):
            response = await service_client.post('/auth/login', json={'username':'health.test', 'password':'health-test-password'})
            assert response.status_code == 503
        assert (await service_client.get('/health/ready')).status_code == 503
        assert (await service_client.get('/healthz')).status_code == 200
        # Probe 503 responses must not retrigger or extend the circuit.
        for _ in range(4):
            assert (await service_client.get('/health/ready')).status_code == 503
    finally:
        with pgsql['authdb'].cursor() as cur:
            cur.execute('ALTER TABLE users_health_test RENAME TO users')
        await asyncio.sleep(2.1)
    assert (await service_client.get('/health/ready')).status_code == 200
    assert (await service_client.post('/auth/login', json={'username':'health.test', 'password':'health-test-password'})).status_code == 401
