#!/usr/bin/env python3
"""Keep only LAN HTTPS forwarded; reconnect after a rollout."""

import signal
import subprocess
import time
from pathlib import Path

import yaml

config = yaml.safe_load((Path(__file__).parent / "config.yaml").read_text())
child = None
stopping = False


def stop(*_):
    global stopping
    stopping = True
    if child is not None:
        child.terminate()


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
while not stopping:
    child = subprocess.Popen(
        [
            "kubectl",
            "--context",
            "colima-" + config["profile"],
            "-n",
            config["namespace"],
            "port-forward",
            "--address",
            "127.0.0.1"
            if config["lan"]["https_port"] == 443
            else "127.0.0.1," + config["lan"]["ip"],
            "service/nginx",
            "8443:8443"
            if config["lan"]["https_port"] == 443
            else str(config["lan"]["https_port"]) + ":8443",
        ]
    )
    child.wait()
    if not stopping:
        time.sleep(2)
