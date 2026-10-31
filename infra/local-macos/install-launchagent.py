#!/usr/bin/env python3
"""Install the local user service outside macOS TCC-protected Documents."""

import json
import os
import plistlib
import shlex
import subprocess
from pathlib import Path

import yaml

root = Path(__file__).resolve().parent
label = "stream.secure-l3.soloapp.local"
folder = Path.home() / "Library/LaunchAgents"
folder.mkdir(parents=True, exist_ok=True)
path = folder / (label + ".plist")
runtime = Path.home() / "Library/Application Support/SoloappLocal"
runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
config = yaml.safe_load((root / "config.yaml").read_text())
(runtime / "config.json").write_text(json.dumps(config))
serve = (
    (root / "serve.py")
    .read_text()
    .replace("import yaml", "import json")
    .replace("yaml.safe_load", "json.loads")
    .replace("config.yaml", "config.json")
)
(runtime / "serve.py").write_text(serve)
start = (
    "#!/bin/sh\nset -eu\nexport PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin\ncd /tmp\ncolima start --profile soloapp-local --activate=false\nexec /opt/homebrew/bin/python3 "
    + shlex.quote(str(runtime / "serve.py"))
    + "\n"
)
(runtime / "start.sh").write_text(start)
value = {
    "Label": label,
    "ProgramArguments": ["/bin/sh", str(runtime / "start.sh")],
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 10,
    "StandardOutPath": str(runtime / "server.log"),
    "StandardErrorPath": str(runtime / "server-error.log"),
}
path.write_bytes(plistlib.dumps(value))
subprocess.run(
    ["launchctl", "bootout", f"gui/{os.getuid()}", str(path)],
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
subprocess.run(["launchctl", "bootstrap", f"gui/{os.getuid()}", str(path)], check=True)
print("Installed user launch agent:", label)
