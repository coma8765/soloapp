#!/usr/bin/env python3
"""Scan publishable worktree, exact index, and existing history without uploading data."""

import hashlib
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FORBIDDEN = {
    "infra/cloud/resources.json",
    "infra/ansible/inventory.yaml",
    "infra/ha/deployment-history.md",
}


REVIEWED_LARGE_ASSETS = {
    "services/soloapp_app/public/assets/avatar/player.glb": "8711d8ac735cf0418384fec1ebabb75d1d11fe8cb7edd2710924f1fdd991cf1b",
    "services/soloapp_app/public/assets/avatar/player-female.glb": "a1925ef139cd2c2a6d5af591b5ea9b7df14ef40cbe666cda2f587a5610c4ad18",
    "services/soloapp_app/public/assets/avatar/uraraka-ochako.glb": "260ea1d80e24c3b97d732aa8247a4bc47cddd158b964251da2b6a605c1252b23",
    "services/soloapp_app/public/assets/marine/clownfish.glb": "1ead5982ec41bffac00a80ab6f3d3b532eadc159d929b6156074b17ed0a46830",
    "services/soloapp_app/public/assets/marine/lobster.glb": "46953edfd7a46a966de71b42db0e58aa419d7b6ee89e072f7e0804c4dc25963a",
    "services/soloapp_app/public/assets/professor/professor-einstein.glb": "ee0b1674d60d5dc464206108caa89d4f333c296e206b2670ac9ce27a9e3b3367",
    "services/soloapp_app/public/assets/reactor/ignalina-control-room-b-3200.jpg": "4fbd59351b261c8d20fb3f89eec9569e87a7175a5dd072b2d53c55588a9c32ce",
    "services/soloapp_app/public/assets/reactor/ignalina-control-room-d-3200.jpg": "eb0f6e89f33fa061f969c1ea627469afa72a9acc315c0db2518ef5883ec90475",
    "services/soloapp_app/public/assets/reactor/ignalina-control-room-f-3200.jpg": "f0dab9359cb2b00c8acfc6df742a16c37734948d88b729cb230e4b001b6ace73",
    "services/soloapp_app/public/assets/reactor/ignalina-control-room-l-3200.jpg": "a43b05af654e483f7dda4687d142f9a1c3aa438f4ef9fd37c384883028dbc632",
    "services/soloapp_app/public/assets/reactor/ignalina-control-room-r-3200.jpg": "c45cba663ebb6e9d658559b25a55a1a85503f15809242a671b390e106f6bc31d",
    "services/soloapp_app/public/assets/reactor/ignalina-control-room-u-3200.jpg": "5f657f3237a9167dbec7dbd6e9b5bea50ae40b334186c8a16e383680af7bed54",
    "services/soloapp_app/public/vendor/babylon.js": "37c77bf920c0d7a3912c28a6120479f3d08fccd87a75e1f7558f76bd124cc6c4",
    "services/soloapp_app/public/assets/world.json": "4e67af509df70d92e86548897cca7113d61cbc7b8b105ad284f9c3a8e2b8c773",
}


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)


def allowed(name):
    path = Path(name)
    if path.is_absolute() or ".." in path.parts or name in FORBIDDEN:
        return False
    if path.parts[0] in ("work", "outputs", ".secrets") or any(
        part.startswith(".venv") for part in path.parts
    ):
        return False
    if "migrations" in path.parts or "__pycache__" in path.parts:
        return False
    if path.name.startswith(".env") and path.name != ".env.example":
        return False
    return (
        path.suffix.lower()
        not in {".pem", ".key", ".p12", ".pfx", ".tar", ".gz", ".db", ".sqlite", ".pyc"}
        and "kubeconfig" not in path.name.lower()
    )


def scan_snapshot(names, staged=False):
    count = 0
    with tempfile.TemporaryDirectory(prefix="soloapp-public-check-") as folder:
        snapshot = Path(folder)
        for name in sorted(set(names)):
            if not name:
                continue
            if not allowed(name):
                raise SystemExit("Forbidden publication path: " + name)
            source = ROOT / name
            if staged:
                entry = git("ls-files", "-s", "--", name).decode()
                if not entry.startswith("100644 ") and not entry.startswith("100755 "):
                    raise SystemExit("Unsupported index file mode: " + name)
                data = git("show", ":" + name)
            else:
                if source.is_symlink():
                    raise SystemExit("Symlinks require explicit publication review: " + name)
                if not source.exists():
                    continue
                data = source.read_bytes()
            if (
                len(data) > 2 * 1024 * 1024
                and REVIEWED_LARGE_ASSETS.get(name) != hashlib.sha256(data).hexdigest()
            ):
                raise SystemExit("Unexpected large publication file: " + name)
            destination = snapshot / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
            count += 1
        subprocess.run(
            [
                "gitleaks",
                "dir",
                str(snapshot),
                "--config",
                str(ROOT / ".gitleaks.toml"),
                "--redact=100",
                "--verbose",
                "--no-banner",
            ],
            check=True,
        )
    print(("Index" if staged else "Working tree") + ": " + str(count) + " files passed", flush=True)


def main():
    if not shutil.which("gitleaks"):
        raise SystemExit("Install gitleaks before publication (for example: brew install gitleaks)")
    names = git("ls-files", "--cached", "--others", "--exclude-standard", "-z").decode().split("\0")
    scan_snapshot(names)
    indexed = git("ls-files", "--cached", "-z").decode().split("\0")
    if any(indexed):
        scan_snapshot(indexed, staged=True)
    if (
        subprocess.run(
            ["git", "rev-parse", "--verify", "HEAD"],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode
        == 0
    ):
        subprocess.run(
            [
                "gitleaks",
                "git",
                str(ROOT),
                "--config",
                str(ROOT / ".gitleaks.toml"),
                "--redact=100",
                "--verbose",
                "--no-banner",
            ],
            check=True,
        )


if __name__ == "__main__":
    main()
