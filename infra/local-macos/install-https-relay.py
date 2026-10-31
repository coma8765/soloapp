#!/usr/bin/env python3
"""Stage a root-owned launchd socket relay; authenticate via the macOS dialog."""

import getpass
import json
import os
import plistlib
import shlex
import subprocess
import tempfile
from pathlib import Path

import yaml

root = Path(__file__).resolve().parent
config = yaml.safe_load((root / "config.yaml").read_text())
label = "stream.secure-l3.soloapp.https"
destination = "/Library/Application Support/SoloappLocal/https-relay.py"
plist = "/Library/LaunchDaemons/" + label + ".plist"
value = {
    "Label": label,
    "UserName": getpass.getuser(),
    "ProgramArguments": ["/opt/homebrew/bin/python3", destination],
    "Sockets": {
        "https": [
            {
                "SockFamily": "IPv4",
                "SockType": "stream",
                "SockNodeName": address,
                "SockServiceName": "443",
            }
            for address in ["127.0.0.1", config["lan"]["ip"]]
        ]
    },
    "RunAtLoad": True,
    "KeepAlive": True,
    "ThrottleInterval": 10,
}
with tempfile.TemporaryDirectory(prefix="soloapp-https-") as temp:
    folder = Path(temp)
    (folder / "relay.py").write_text((root / "https-relay.py").read_text())
    (folder / "relay.plist").write_bytes(plistlib.dumps(value))
    q = shlex.quote
    script = "\n".join(
        [
            "set -eu",
            "/bin/mkdir -p " + q(str(Path(destination).parent)),
            "/usr/sbin/chown root:wheel " + q(str(Path(destination).parent)),
            "/bin/chmod 755 " + q(str(Path(destination).parent)),
            "/usr/bin/install -o root -g wheel -m 644 "
            + q(str(folder / "relay.py"))
            + " "
            + q(destination),
            "/usr/bin/install -o root -g wheel -m 644 "
            + q(str(folder / "relay.plist"))
            + " "
            + q(plist),
            "/bin/launchctl bootout system/" + label + " 2>/dev/null || true",
            "/bin/launchctl bootstrap system " + q(plist),
        ]
    )
    if os.geteuid() == 0:
        raise SystemExit("Run as the normal Mac user, not sudo")
    # The dialog handles the password; it never enters Python or terminal output.
    subprocess.run(
        [
            "osascript",
            "-e",
            "do shell script " + json.dumps(script) + " with administrator privileges",
        ],
        check=True,
    )
print("Installed unprivileged HTTPS relay on port 443")
