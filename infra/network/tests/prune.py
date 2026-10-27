#!/usr/bin/env python3
"""Remove only stale policies owned by this isolation manifest (never service policies)."""

import json
import subprocess
import sys


def stale(desired, current):
    keep = {(p["metadata"]["namespace"], p["metadata"]["name"]) for p in desired["items"]}
    return [
        (p["metadata"]["namespace"], p["metadata"]["name"])
        for p in current["items"]
        if p["metadata"].get("labels", {}).get("soloapp.io/network-policy") == "isolation"
        and (p["metadata"]["namespace"], p["metadata"]["name"]) not in keep
    ]


def objects(stream):
    decoder = json.JSONDecoder()
    items = []
    remaining = stream.strip()
    while remaining:
        value, end = decoder.raw_decode(remaining)
        items.extend(value["items"] if value.get("kind") == "List" else [value])
        remaining = remaining[end:].lstrip()
    return {"items": items}


def main():
    base = ["k3s", "kubectl"]
    desired = objects(
        subprocess.check_output(
            base + ["create", "--dry-run=client", "-f", sys.argv[1], "-o", "json"], text=True
        )
    )
    current = json.loads(
        subprocess.check_output(
            base
            + [
                "get",
                "networkpolicy",
                "-A",
                "-l",
                "soloapp.io/network-policy=isolation",
                "-o",
                "json",
            ]
        )
    )
    for namespace, name in stale(desired, current):
        subprocess.run(base + ["-n", namespace, "delete", "networkpolicy", name], check=True)


if __name__ == "__main__":
    main()
