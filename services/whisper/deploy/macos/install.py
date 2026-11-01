#!/usr/bin/env python3
"""Install a loopback-only Metal worker; run with Python 3.12 on Apple Silicon."""

import os
import plistlib
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
LABEL = "stream.soloapp.whisper-metal"
STATE = ROOT / "work"
VENV = STATE / "whisper-metal-py312"
MODEL = STATE / "whisper-metal-model"
REVISION = "a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb"


def main():
    subprocess.run(["python3.12", "-m", "venv", str(VENV)], check=True)
    subprocess.run(
        [str(VENV / "bin/pip"), "install", "-r", str(Path(__file__).with_name("requirements.txt"))],
        check=True,
    )
    env = {k: v for k, v in os.environ.items() if k != "HF_TOKEN"}
    env["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    subprocess.run(
        [
            "hf",
            "download",
            "mlx-community/whisper-large-v3-turbo",
            "--revision",
            REVISION,
            "--local-dir",
            str(MODEL),
        ],
        env=env,
        check=True,
    )
    target = Path.home() / "Library/LaunchAgents" / (LABEL + ".plist")
    target.parent.mkdir(parents=True, exist_ok=True)
    config = {
        "Label": LABEL,
        "ProgramArguments": [
            str(VENV / "bin/python"),
            str(ROOT / "services/whisper/src/metal.py"),
            "--model",
            str(MODEL),
        ],
        "WorkingDirectory": str(ROOT),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 15,
        "EnvironmentVariables": {
            "HF_HUB_OFFLINE": "1",
            "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "NUMBA_CACHE_DIR": str(STATE / "whisper-numba"),
        },
        "StandardOutPath": str(STATE / "whisper-metal.log"),
        "StandardErrorPath": str(STATE / "whisper-metal-error.log"),
    }
    target.write_bytes(plistlib.dumps(config))
    target.chmod(0o600)
    domain = f"gui/{os.getuid()}"
    subprocess.run(["launchctl", "bootout", domain + "/" + LABEL], check=False, capture_output=True)
    subprocess.run(["launchctl", "bootstrap", domain, str(target)], check=True)
    print("Metal worker installed; verify /healthz before routing the Kubernetes Service")


if __name__ == "__main__":
    main()
