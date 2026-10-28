#!/usr/bin/env python3
"""Switch only registry storage configs in Lockbox, preserving existing TLS identities."""

import argparse
import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "object-storage"))
from bootstrap import STATE, yc  # noqa: E402


def filesystem_config(cfg):
    result = copy.deepcopy(cfg)
    storage = result["storage"]
    storage.pop("s3", None)
    storage["filesystem"] = {"rootdirectory": "/var/lib/registry"}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site", choices=["yc", "home"])
    args = parser.parse_args()
    secret = json.loads(STATE.read_text())["secrets"]["registry-" + args.site]
    entries = yc("lockbox", "payload", "get", secret)["entries"]
    changed = False
    payload = []
    for entry in entries:
        name = entry["key"]
        value = entry.get("textValue", entry.get("text_value"))
        if name in ("read.json", "write.json"):
            current = json.loads(value)
            new = filesystem_config(current)
            changed |= new != current
            value = json.dumps(new)
        payload.append({"key": name, "textValue": value})
    if changed:
        yc(
            "lockbox",
            "secret",
            "add-version",
            secret,
            "--payload",
            "-",
            payload=json.dumps(payload),
        )
    print(args.site + ": filesystem configuration stored; TLS identities preserved")


if __name__ == "__main__":
    main()
