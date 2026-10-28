#!/usr/bin/env python3
"""Overlay a locally compiled Headlamp binary on a validated upstream OCI archive."""

import gzip
import hashlib
import importlib.util
import io
import json
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("registry_push", ROOT / "infra/registry/push.py")
push = importlib.util.module_from_spec(spec)
spec.loader.exec_module(push)


def encode(value):
    return json.dumps(value, separators=(",", ":")).encode()


def main():
    base, binary, revision, output = sys.argv[1:]
    tar, members, manifest, _, config = push.load_archive(base)
    layer = io.BytesIO()
    with tarfile.open(fileobj=layer, mode="w") as archive:
        data = Path(binary).read_bytes()
        entry = tarfile.TarInfo("headlamp/headlamp-server")
        entry.mode = 0o755
        entry.size = len(data)
        archive.addfile(entry, io.BytesIO(data))
    raw = layer.getvalue()
    packed = gzip.compress(raw, mtime=0)
    config["rootfs"]["diff_ids"].append(push.digest(raw))
    config.setdefault("history", []).append(
        {"created_by": "soloapp Headlamp OIDC base-path hotfix"}
    )
    config["config"].setdefault("Labels", {}).update(
        {
            "org.opencontainers.image.revision": revision,
            "io.soloapp.headlamp.patch": hashlib.sha256(
                (ROOT / "infra/headlamp/patches/oidc-base-path.patch").read_bytes()
            ).hexdigest(),
        }
    )
    blobs = {}

    def blob(data, media):
        digest = push.digest(data)
        blobs["blobs/sha256/" + digest[7:]] = data
        return {"mediaType": media, "digest": digest, "size": len(data)}

    manifest["layers"].append(blob(packed, "application/vnd.oci.image.layer.v1.tar+gzip"))
    manifest["config"] = blob(encode(config), manifest["config"]["mediaType"])
    desc = blob(encode(manifest), manifest["mediaType"])
    desc["platform"] = {"os": "linux", "architecture": "amd64"}
    blobs["index.json"] = encode({"schemaVersion": 2, "manifests": [desc]})
    blobs["oci-layout"] = encode({"imageLayoutVersion": "1.0.0"})
    with tarfile.open(output, "w") as dest:
        for name, member in members.items():
            if name.startswith("blobs/") and name not in blobs:
                dest.addfile(member, tar.extractfile(member))
        for name, data in blobs.items():
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            entry.mode = 0o644
            dest.addfile(entry, io.BytesIO(data))
    tar.close()
    checked, _, _, checked_manifest, _ = push.load_archive(output)
    checked.close()
    print(push.digest(checked_manifest))


if __name__ == "__main__":
    main()
