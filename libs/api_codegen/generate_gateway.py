#!/usr/bin/env python3
"""Generate gateway paths from its API contract."""

import argparse
import json
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    spec = yaml.safe_load((ROOT / "services/client-gateway/docs/api.yaml").read_text())
    routes = {
        op["operationId"]: path for path, item in spec["paths"].items() for op in item.values()
    }
    assert set(routes) == {"delivery", "cancel", "socket"}
    content = (
        "// Generated from docs/api.yaml; do not edit.\nexport const routes = "
        + json.dumps(routes, indent=2)
        + ";\n"
    )
    target = ROOT / "services/client-gateway/src/generated/routes.mjs"
    if args.check:
        assert target.read_text() == content, "Run make codegen-client-gateway"
    else:
        target.write_text(content)


if __name__ == "__main__":
    main()
