from pathlib import Path

from libs.api_codegen.route_policy import load


async def test_generated_body_limit(service_client):
    spec = load(Path(__file__).resolve().parents[1])
    limit = spec["paths"]["/api/v1/auth/v1/login"]["post"]["x-route"]["max_body_bytes"]
    response = await service_client.post("/api/v1/auth/v1/login", data="x" * (limit + 1))
    assert response.status == 413
