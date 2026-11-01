#!/usr/bin/env python3
"""Disposable actual-auth + two-game-server integration; never connects to production.

Build soloapp-metrics-test (game build target), soloapp-auth-metrics-test (auth tests
stage), install ws for Node, then run with DOCKER_CONTEXT=colima-soloapp-local.
NODE_PATH can point at a temporary ws installation. Images can be overridden below.
"""

import json
import os
import subprocess
import time
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DOCKER = ["docker"]
if os.environ.get("DOCKER_CONTEXT"):
    DOCKER += ["--context", os.environ["DOCKER_CONTEXT"]]
GAME = os.environ.get("GAME_TEST_IMAGE", "soloapp-metrics-test")
AUTH = os.environ.get("AUTH_TEST_IMAGE", "soloapp-auth-metrics-test")
NAME = "soloapp-metrics-" + uuid.uuid4().hex[:10]
containers = []


def docker(*args, **kwargs):
    return subprocess.check_output(DOCKER + list(args), text=True, **kwargs).strip()


def launch(suffix, *args):
    name = NAME + "-" + suffix
    containers.append(name)
    docker("run", "-d", "--name", name, "--network", NAME, *args)
    return name


def endpoint(name, port):
    mapping = json.loads(docker("inspect", name))[0]["NetworkSettings"]["Ports"][f"{port}/tcp"][0]
    return "http://127.0.0.1:" + mapping["HostPort"]


def ready(url):
    for _ in range(150):
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except Exception:
            pass
        time.sleep(0.2)
    raise RuntimeError("Service did not become ready: " + url)


docker("network", "create", NAME)
try:
    pg = launch(
        "pg",
        "--network-alias",
        "postgres",
        "-e",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        "postgres:16-bookworm",
    )
    for _ in range(100):
        check = subprocess.run(
            DOCKER + ["exec", pg, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"],
            capture_output=True,
        )
        if check.returncode == 0:
            break
        time.sleep(0.2)
    else:
        raise RuntimeError("PostgreSQL did not become ready")
    for schema in [
        "services/auth/tests/schemas/authdb.sql",
        "services/soloapp_app/deploy/schema.sql",
    ]:
        docker(
            "exec",
            "-i",
            pg,
            "psql",
            "-h",
            "127.0.0.1",
            "-U",
            "postgres",
            "-v",
            "ON_ERROR_STOP=1",
            input=(ROOT / schema).read_text(),
        )
    common = ["-e", "DATABASE_URL_FILE=/tmp/metrics-dsn", "-e", "LISTEN_ADDRESS=0.0.0.0"]
    init = "printf '%s' 'host=postgres dbname=postgres user=postgres sslmode=disable' > /tmp/metrics-dsn; exec "
    auth = launch(
        "auth",
        "--network-alias",
        "auth",
        *common,
        "-e",
        "PORT=19082",
        "-p",
        "127.0.0.1::19082",
        "--entrypoint",
        "/bin/sh",
        AUTH,
        "-c",
        init + "/src/build/services/auth/auth-service",
    )
    auth_url = endpoint(auth, 19082)
    ready(auth_url + "/ready")
    origin = "http://127.0.0.1:4199"
    urls = []
    for side in ["a", "b"]:
        game = launch(
            side,
            *common,
            "-e",
            "AUTH_URL=http://auth:19082",
            "-e",
            "CHAT_ALLOWED_ORIGIN=" + origin,
            "-e",
            "WORLD_NAVIGATION=/src/services/soloapp_app/src/data/lakes.json",
            "-p",
            "127.0.0.1::8080",
            "--entrypoint",
            "/bin/sh",
            GAME,
            "-c",
            init + "/src/build/soloapp-app",
        )
        url = endpoint(game, 8080)
        ready(url + "/health/ready")
        urls.append(url.replace("http:", "ws:") + "/api/v1/soloapp_app/v1/signal")
    subprocess.run(
        [
            "node",
            str(ROOT / "services/soloapp_app/tests/participants-wire.mjs"),
            auth_url,
            *urls,
            origin,
        ],
        check=True,
    )
finally:
    for name in reversed(containers):
        subprocess.run(
            DOCKER + ["rm", "-fv", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
    docker("network", "rm", NAME)
