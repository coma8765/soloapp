import asyncio
import json
import os


async def test_deadline_30_seconds():
    process = await asyncio.create_subprocess_exec(
        os.environ["UNIT_PROBE"], "deadline", stdout=asyncio.subprocess.PIPE
    )
    stdout, _ = await asyncio.wait_for(process.communicate(), 40)
    assert process.returncode == 0
    result = json.loads(stdout)
    assert result["unacked_task_requeued"]
    assert result["expired"]
    assert 29500 <= result["elapsed_ms"] <= 32000
    assert result["early_completion_cancelled_timer"]


async def test_odb_lease_fences_stale_completion(pgsql, pgsql_local, tmp_path):
    path = tmp_path / "dsn"
    path.write_text(pgsql_local["leasedb"].get_dsn())
    process = await asyncio.create_subprocess_exec(
        os.environ["UNIT_PROBE"],
        stdout=asyncio.subprocess.PIPE,
        env={**os.environ, "DATABASE_URL_FILE": str(path)},
    )
    stdout, _ = await asyncio.wait_for(process.communicate(), 10)
    assert process.returncode == 0
    result = json.loads(stdout)
    assert all(result.values()), result
