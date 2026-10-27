from libs.api_codegen.route_policy import load
from pathlib import Path

async def test_generated_body_limit(service_client):
    spec = load(Path(__file__).resolve().parents[1])
    limit = spec['paths']['/user-id']['get']['x-route']['max_body_bytes']
    response = await service_client.get('/user-id', data='x' * (limit + 1))
    assert response.status == 413
