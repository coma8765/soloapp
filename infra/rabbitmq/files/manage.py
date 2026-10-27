#!/usr/bin/env python3
"""Two local RabbitMQ nodes; per-DC cookies and credentials stay in Lockbox/tmpfs."""

import base64
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

BASE = Path("/opt/hack-vk-26/rabbitmq")
RUNTIME = Path("/run/soloapp-rabbitmq-runtime")


def write(path, text):
    path.write_text(text)
    path.chmod(0o400)
    os.chown(path, 999, 999)


def definitions(credentials):
    salt = hashlib.sha256(credentials["password"].encode()).digest()[:4]
    password_hash = base64.b64encode(
        salt + hashlib.sha256(salt + credentials["password"].encode()).digest()
    ).decode()
    return {
        "users": [
            {
                "name": "notify",
                "password_hash": password_hash,
                "hashing_algorithm": "rabbit_password_hashing_sha256",
                "tags": [],
            }
        ],
        "vhosts": [{"name": "/soloapp"}],
        "permissions": [
            {
                "user": "notify",
                "vhost": "/soloapp",
                "configure": "^$",
                "write": "^amq\\.default$",
                "read": "^client-notify$",
            }
        ],
        "queues": [
            {
                "name": "client-notify",
                "vhost": "/soloapp",
                "durable": True,
                "auto_delete": False,
                "arguments": {
                    "x-queue-type": "quorum",
                    "x-quorum-initial-group-size": 2,
                    "x-delivery-limit": -1,
                },
            }
        ],
        "policies": [
            {
                "vhost": "/soloapp",
                "name": "delivery-deadline",
                "pattern": "^client-notify$",
                "apply-to": "quorum_queues",
                "priority": 10,
                "definition": {"consumer-timeout": 60000},
            }
        ],
    }


def main(number):
    config = json.loads((BASE / "config.json").read_text())
    credentials = json.loads(Path("/run/soloapp-rabbitmq/credentials.json").read_text())
    runtime = RUNTIME / str(number)
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chown(runtime, 999, 999)
    write(runtime / ".erlang.cookie", credentials["cookie"])
    write(runtime / "definitions.json", json.dumps(definitions(credentials)))
    write(runtime / "enabled_plugins", "[rabbitmq_prometheus].\n")
    index = number - 1
    text = f"""listeners.tcp = none
listeners.ssl.1 = {config["ip"]}:{config["ports"][index]}
ssl_options.cacertfile = /tls/ca.crt
ssl_options.certfile = /tls/tls.crt
ssl_options.keyfile = /tls/tls.key
ssl_options.verify = verify_none
ssl_options.fail_if_no_peer_cert = false
cluster_name = soloapp-{config["site"]}
cluster_formation.peer_discovery_backend = classic_config
cluster_formation.classic_config.nodes.1 = rabbit1@localhost
cluster_formation.classic_config.nodes.2 = rabbit2@localhost
cluster_partition_handling = pause_minority
vm_memory_high_watermark.absolute = {config["watermark"]}
disk_free_limit.absolute = 1GB
consumer_timeout = 60000
prometheus.tcp.ip = {config["ip"]}
prometheus.tcp.port = {config["metrics_ports"][index]}
"""
    write(runtime / "rabbitmq.conf", text)
    name = f"solo-rabbitmq-{number}"
    subprocess.run(
        ["docker", "rm", "-f", name],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    args = [
        "docker",
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "host",
        "--user",
        "999:999",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--read-only",
        "--memory",
        config["memory"],
        "--cpus",
        config["cpus"],
        "--pids-limit",
        "128",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "--log-opt",
        "max-size=5m",
        "--log-opt",
        "max-file=2",
        "-e",
        "HOME=/runtime",
        "-e",
        f"RABBITMQ_NODENAME=rabbit{number}@localhost",
        "-e",
        f"RABBITMQ_DIST_PORT={config['distribution_ports'][index]}",
        "-e",
        "ERL_EPMD_ADDRESS=127.0.0.1",
        "-e",
        "RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS=+S 2:2 -kernel inet_dist_use_interface {127,0,0,1}",
        "-e",
        "RABBITMQ_CONFIG_FILE=/runtime/rabbitmq",
        "-e",
        "RABBITMQ_ENABLED_PLUGINS_FILE=/runtime/enabled_plugins",
        "-e",
        "RABBITMQ_LOGS=-",
        "-v",
        f"{runtime}:/runtime:ro",
        "-v",
        "/run/soloapp-node:/tls:ro",
        "-v",
        f"/var/lib/soloapp-rabbitmq/{number}:/var/lib/rabbitmq",
        config["image"],
    ]
    process = subprocess.Popen(args)
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        if not stopping:
            stopping = True
            subprocess.run(
                ["docker", "stop", "-t", "30", name], stdout=subprocess.DEVNULL, check=False
            )

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    fingerprint = None
    next_check = 0.0
    while process.poll() is None:
        if time.monotonic() >= next_check:
            new = hashlib.sha256(Path("/run/soloapp-node/tls.crt").read_bytes()).digest()
            if fingerprint is not None and new != fingerprint:
                subprocess.run(
                    [
                        "docker",
                        "exec",
                        "--user",
                        "999:999",
                        name,
                        "rabbitmqctl",
                        "eval",
                        "ssl:clear_pem_cache().",
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
            fingerprint = new
            next_check = time.monotonic() + 60
        time.sleep(1)
    return process.returncode


if __name__ == "__main__":
    node = int(sys.argv[1])
    if node not in (1, 2):
        raise SystemExit("Expected node 1 or 2")
    raise SystemExit(main(node))
