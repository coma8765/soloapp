import json
import os
import subprocess
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[3]


def test_infinite_retries_and_supported_broker_fallback():
    config = yaml.safe_load((ROOT / "infra/rabbitmq/client-notify.yaml").read_text())
    queue = config["queues"][0]
    assert queue["durable"]
    assert queue["arguments"]["x-queue-type"] == "quorum"
    assert queue["arguments"]["x-delivery-limit"] == -1
    assert "x-message-ttl" not in queue["arguments"]
    assert config["policies"][0]["definition"]["consumer-timeout"] == 60000
    defaults = yaml.safe_load((ROOT / "services/client-notify/deploy/defaults.yaml").read_text())
    assert defaults["ack_timeout_ms"] == 30000
    assert defaults["delivery_timeout_ms"] == 10000


@pytest.mark.parametrize(
    "delivery,ack,port,valid",
    [
        (10000, 30000, 5672, True),
        (2**32 - 1, 30000, 5672, False),
        (10000, 10000, 5672, False),
        (10000, 30000, 65536, False),
    ],
)
def test_runtime_config_bounds(tmp_path, delivery, ack, port, valid):
    config = tmp_path / "config.json"
    config.write_text(
        json.dumps(
            {
                "rabbitmq": {
                    "host": "rabbit",
                    "user": "notifytest",
                    "password": "synthetic-local-only",
                    "tls": False,
                    "port": port,
                },
                "gateway": {"url": "http://localhost", "token": "synthetic-test"},
                "delivery_timeout_ms": delivery,
                "ack_timeout_ms": ack,
            }
        )
    )
    result = subprocess.run(
        [os.environ["UNIT_PROBE"], "config"],
        env={**os.environ, "NOTIFY_CONFIG_FILE": str(config), "NOTIFY_TEST_ALLOW_PLAINTEXT": "1"},
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert result.returncode == (0 if valid else 2)
    if valid:
        assert json.loads(result.stdout) == {"delivery_ms": delivery, "ack_ms": ack}
