#!/usr/bin/env python3
"""Generate native ES-module request clients and literal C++ game routes from YAML."""

import argparse
import json
from pathlib import Path

from route_policy import load, operations

ROOT = Path(__file__).resolve().parents[2]


def outputs():
    routes = {}
    for service in ("auth", "soloapp_app"):
        for path, method, op in operations(load(ROOT / "services" / service)):
            if op["x-route"]["exposure"] == "public":
                routes[op["operationId"]] = {
                    "path": path,
                    "method": method.upper(),
                    "timeout": op["x-route"]["timeouts"]["read_seconds"] * 1000,
                    "success": [int(s) for s in op["responses"] if s.startswith("2")],
                    "websocket": op.get("x-websocket", False),
                }
    js = (
        "// Generated from docs/api.yaml; do not edit.\nexport const operations = "
        + json.dumps(routes, indent=2)
        + ";\n"
    )
    cpp = "#pragma once\n// Generated from services/soloapp_app/docs/api.yaml.\nnamespace planet::routes {\n"
    for path, _, op in operations(load(ROOT / "services/soloapp_app")):
        cpp += f'inline constexpr const char *{op["operationId"]} = "{path}";\n'
    cpp += "}\n"
    return {
        ROOT / "services/soloapp_app/public/client/generated/api.js": js,
        ROOT / "services/soloapp_app/src/generated/routes.hpp": cpp,
    }


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--check", action="store_true")
    args = p.parse_args()
    for path, text in outputs().items():
        if args.check:
            if not path.exists() or path.read_text() != text:
                raise SystemExit(f"Stale generated file: {path}")
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)


if __name__ == "__main__":
    main()
