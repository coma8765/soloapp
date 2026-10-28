#!/usr/bin/env python3
"""Copy the dedicated notification credential from Lockbox into GitHub production secrets."""

import json
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "infra/object-storage"))
from bootstrap import STATE, yc


def main():
    cloud = json.loads(STATE.read_text())
    payload = yc("lockbox", "payload", "get", cloud["secrets"]["cd-notify-relay"])
    entries = {e["key"]: e.get("text_value", e.get("textValue")) for e in payload["entries"]}
    token = entries["relay-token"]
    url = urlsplit(cloud["telegram_relay"]["url"])
    if url.scheme != "https" or url.username or url.password or url.query or url.fragment:
        raise ValueError("Invalid relay URL")
    endpoint = urlunsplit((url.scheme, url.netloc, "/deployments", "", ""))
    for name, value in {"CD_NOTIFY_TOKEN": token, "CD_NOTIFY_URL": endpoint}.items():
        subprocess.run(
            ["gh", "secret", "set", name, "--env", "production", "--repo", "coma8765/soloapp"],
            input=value,
            text=True,
            check=True,
            capture_output=True,
        )
    print("Configured dedicated deployment notification secrets in GitHub production")


if __name__ == "__main__":
    main()
