import asyncio
import time
import uuid

import pytest

HEADERS = {"Authorization": "Bearer synthetic-notify-test-token"}
BASE = "/api/v1/client-notify/v1/"


def task():
    return {"task_id": uuid.uuid4().hex, "recipient": "test-user", "payload": "hello"}


async def completed(client, key, timeout=15):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        response = await client.post(BASE + "status", json={"task_id": key}, headers=HEADERS)
        if response.status == 200 and response.json()["state"] == "done":
            return response.json()
        await asyncio.sleep(0.1)
    pytest.fail("delivery did not complete")


async def test_auth_and_validation(service_client):
    response = await service_client.post(BASE + "tasks", json=task())
    assert response.status == 401
    response = await service_client.post(BASE + "tasks", json={"task_id": "bad"}, headers=HEADERS)
    assert response.status == 400


async def test_success_and_idempotency(service_client, mockserver):
    received = []

    @mockserver.json_handler("/internal/delivery")
    def delivery(request):
        data = request.json
        received.append(data)
        assert request.headers["Idempotency-Key"] == data["task_id"]
        return {"task_id": data["task_id"], "attempt": data["attempt"], "status": "delivered"}

    data = task()
    response = await service_client.post(BASE + "tasks", json=data, headers=HEADERS)
    assert response.status == 202
    result = await completed(service_client, data["task_id"])
    assert result["attempt"] == 1
    response = await service_client.post(BASE + "tasks", json=data, headers=HEADERS)
    assert response.json()["state"] == "done"
    response = await service_client.post(
        BASE + "tasks", json={**data, "payload": "different"}, headers=HEADERS
    )
    assert response.status == 409
    await asyncio.sleep(1)
    assert len(received) == 1


async def test_error_retries_before_ack(service_client, mockserver):
    attempts = []

    @mockserver.handler("/internal/delivery")
    def delivery(request):
        data = request.json
        attempts.append(data["attempt"])
        if len(attempts) == 1:
            return mockserver.make_response("unavailable", 503)
        return mockserver.make_response(
            json={"task_id": data["task_id"], "attempt": data["attempt"], "status": "delivered"}
        )

    @mockserver.json_handler("/internal/delivery/cancel")
    def cancel(request):
        return {"cancelled": True}

    data = task()
    assert (await service_client.post(BASE + "tasks", json=data, headers=HEADERS)).status == 202
    result = await completed(service_client, data["task_id"])
    assert result["attempt"] >= 2
    assert attempts[1] > attempts[0]


async def test_timeout_cancels_without_waiting(service_client, mockserver):
    attempts = []
    cancellations = []

    @mockserver.json_handler("/internal/delivery")
    async def delivery(request):
        data = request.json
        attempts.append((data["attempt"], time.monotonic()))
        if len(attempts) == 1:
            await asyncio.sleep(15)
        return {"task_id": data["task_id"], "attempt": data["attempt"], "status": "delivered"}

    @mockserver.json_handler("/internal/delivery/cancel")
    async def cancel(request):
        cancellations.append(request.json)
        await asyncio.sleep(5)  # cancellation completion must not delay the retry
        return {"cancelled": True}

    data = task()
    assert (await service_client.post(BASE + "tasks", json=data, headers=HEADERS)).status == 202
    result = await completed(service_client, data["task_id"], 25)
    assert result["attempt"] >= 2
    assert 9 <= attempts[1][1] - attempts[0][1] < 14
    assert cancellations[0]["task_id"] == data["task_id"]
    assert cancellations[0]["attempt"] == attempts[0][0]
