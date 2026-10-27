#!/usr/bin/env python3
"""Run stock Redis containers; keep credentials in RAM, persist only nonsecret topology."""

import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

RUNTIME = Path("/run/soloapp-redis-runtime")
STATE = Path("/var/lib/soloapp-redis")


def topology(text, mode):
    allowed = {
        "myid",
        "monitor",
        "config-epoch",
        "leader-epoch",
        "current-epoch",
        "known-replica",
        "known-slave",
        "known-sentinel",
    }
    result = []
    for line in text.splitlines():
        parts = line.split()
        if mode == "sentinel" and len(parts) > 2 and parts[0] == "sentinel" and parts[1] in allowed:
            result.append(line)
        elif mode == "redis" and len(parts) == 3 and parts[0] == "replicaof":
            result.append(line)
    return "\n".join(result) + "\n"


def atomic(path, text, owner=False):
    if path.exists() and path.read_text() == text:
        return
    tmp = path.with_suffix(".tmp")
    tmp.write_text(text)
    tmp.chmod(0o600)
    if owner:
        os.chown(tmp, 999, 999)
    tmp.replace(path)


def render(config, credentials, mode, saved=None):
    ip, name = config["ip"], config["master_name"]
    port = config["sentinel_port"] if mode == "sentinel" else config["port"]
    common = f"""bind {ip} 127.0.0.1
protected-mode yes
port 0
tls-port {port}
tls-cert-file /tls/tls.crt
tls-key-file /tls/tls.key
tls-ca-cert-file /tls/ca.crt
tls-auth-clients no
tls-replication yes
aclfile /runtime/{mode}.acl
loglevel notice
"""

    def user(name, password, grants):
        return f"user {name} on #{hashlib.sha256(password.encode()).hexdigest()} {grants}\n"

    acl = "user default off\n" + user("operator", credentials["operator"], "~* &* +@all")
    if mode == "redis":
        acl += user("replication", credentials["replication"], "+psync +replconf +ping")
        acl += user(
            "sentinel",
            credentials["sentinel"],
            "~* &__sentinel__:hello +multi +exec +ping +info +role +subscribe +publish +client|setname +client|kill +config|rewrite +replicaof +slaveof +script|kill",
        )
        acl += user(
            "chat",
            credentials["chat"],
            "~soloapp:chat:* +ping +info +client|setinfo +client|setname +get +set +incr +expire +eval +xadd +xrevrange",
        )
        # An empty saved file is meaningful: this node was promoted to master.
        role = (
            saved
            if saved is not None
            else (
                f"replicaof {config['initial_master']} {config['port']}\n"
                if ip != config["initial_master"]
                else ""
            )
        )
        return (
            common
            + f"""dir /data
appendonly yes
appendfsync everysec
save 60 1
maxmemory {config["maxmemory"]}
maxmemory-policy noeviction
masteruser replication
masterauth {credentials["replication"]}
replica-announce-ip {ip}
replica-announce-port {config["port"]}
min-replicas-to-write {config["min_replicas_to_write"]}
"""
            + role,
            acl,
        )
    acl += user("sentinel", credentials["sentinel"], "&* +@all")
    acl += user(
        "discovery",
        credentials["discovery"],
        "+ping +hello +client|setname +client|setinfo +sentinel|get-master-addr-by-name +sentinel|sentinels +sentinel|replicas +sentinel|slaves +sentinel|master",
    )
    initial = (
        f"sentinel monitor {name} {config['initial_master']} {config['port']} {config['quorum']}\n"
    )
    return (
        common
        + (saved if saved is not None else initial)
        + f"""sentinel announce-ip {ip}
sentinel announce-port {port}
sentinel auth-user {name} sentinel
sentinel auth-pass {name} {credentials["sentinel"]}
sentinel sentinel-user sentinel
sentinel sentinel-pass {credentials["sentinel"]}
sentinel down-after-milliseconds {name} {config["down_after_ms"]}
sentinel failover-timeout {name} {config["failover_timeout_ms"]}
sentinel parallel-syncs {name} 1
""",
        acl,
    )


def run(mode):
    config = json.loads(Path("/opt/hack-vk-26/redis/config.json").read_text())
    credentials = json.loads(Path("/run/soloapp-redis/credentials.json").read_text())
    RUNTIME.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chown(RUNTIME, 999, 999)
    state_file = STATE / (mode + "-topology.conf")
    config_file = RUNTIME / (mode + ".conf")
    # Prefer the most recent in-RAM topology, including CONFIG REWRITE during failover.
    saved = (
        topology(config_file.read_text(), mode)
        if config_file.exists()
        else (state_file.read_text() if state_file.exists() else None)
    )
    text, acl = render(config, credentials, mode, saved)
    atomic(config_file, text, True)
    atomic(RUNTIME / (mode + ".acl"), acl, True)
    name = "solo-" + mode
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
        config[mode + "_memory"],
        "--cpus",
        "0.5",
        "--pids-limit",
        "64",
        "--log-opt",
        "max-size=5m",
        "--log-opt",
        "max-file=2",
        "-v",
        str(RUNTIME) + ":/runtime",
        "-v",
        "/run/soloapp-node:/tls:ro",
        "-v",
        str(STATE / "data") + ":/data",
        config["image"],
        "redis-server",
        "/runtime/" + mode + ".conf",
    ]
    if mode == "sentinel":
        args.append("--sentinel")
    process = subprocess.Popen(args)
    stopping = False

    def stop(_signum, _frame):
        nonlocal stopping
        if not stopping:
            stopping = True
            subprocess.run(
                ["docker", "stop", "-t", "20", name], stdout=subprocess.DEVNULL, check=False
            )

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while True:
        if config_file.exists():
            atomic(state_file, topology(config_file.read_text(), mode))
        if process.poll() is not None:
            return process.returncode
        time.sleep(1)


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode not in ("redis", "sentinel"):
        raise SystemExit("Expected redis or sentinel")
    raise SystemExit(run(mode))
