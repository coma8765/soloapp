from pathlib import Path

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
