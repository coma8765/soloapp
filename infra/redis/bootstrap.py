#!/usr/bin/env python3
"""Create Redis ACL credentials in Lockbox; never persist or print plaintext locally."""

import json
import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "object-storage"))
from bootstrap import STATE, yc


def values(secret):
    return {
        e["key"]: e.get("textValue", e.get("text_value"))
        for e in yc("lockbox", "payload", "get", secret)["entries"]
    }


def payload(data):
    return json.dumps([{"key": k, "textValue": v} for k, v in data.items()])


def main():
    state = json.loads(STATE.read_text())
    name = "redis-server"
    if name not in state["secrets"]:
        credentials = {
            k: secrets.token_hex(32)
            for k in ("operator", "replication", "sentinel", "discovery", "chat")
        }
        state["secrets"][name] = yc(
            "lockbox",
            "secret",
            "create",
            "--name",
            "soloapp-redis-server",
            "--deletion-protection",
            "--payload",
            "-",
            payload=payload({"credentials.json": json.dumps(credentials)}),
        )["id"]
        STATE.write_text(json.dumps(state, indent=2) + "\n")
        STATE.chmod(0o600)
    credentials = json.loads(values(state["secrets"][name])["credentials.json"])
    for site in ("yc", "home", "edge"):
        yc(
            "lockbox",
            "secret",
            "add-access-binding",
            state["secrets"][name],
            "--role",
            "lockbox.payloadViewer",
            "--service-account-id",
            state["identities"]["node-" + site],
        )
    ca = values(state["secrets"]["node-yc"])["ca.crt"]
    config = {
        "sentinels": [{"host": f"10.77.26.{n}", "port": 26379} for n in (11, 12, 13)],
        "name": "soloapp-chat",
        "username": "chat",
        "password": credentials["chat"],
        "sentinelUsername": "discovery",
        "sentinelPassword": credentials["discovery"],
        "ca": ca,
    }
    for site in ("yc", "home"):
        secret = state["secrets"]["whoami-" + site]
        data = values(secret)
        new = json.dumps(config)
        if data.get("redis-client.json") != new:
            data["redis-client.json"] = new
            yc("lockbox", "secret", "add-version", secret, "--payload", "-", payload=payload(data))
    print("Redis credentials stored in Lockbox; application receives chat/discovery ACL only")


if __name__ == "__main__":
    main()
