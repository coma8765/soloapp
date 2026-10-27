import importlib.util
import io
import json
import tarfile
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "registry_push", Path(__file__).parents[1] / "push.py"
)
push = importlib.util.module_from_spec(spec)
spec.loader.exec_module(push)


class ArchiveTests(unittest.TestCase):
    def archive(self, folder, corrupt=False, extra=None, architecture="amd64"):
        config = json.dumps(
            {
                "os": "linux",
                "architecture": architecture,
                "config": {"Labels": {"org.opencontainers.image.revision": "a" * 40}},
            }
        ).encode()
        layer = b"layer"

        def descriptor(data):
            return {"digest": push.digest(data), "size": len(data)}

        manifest = json.dumps(
            {"schemaVersion": 2, "config": descriptor(config), "layers": [descriptor(layer)]}
        ).encode()
        entries = {
            "oci-layout": b'{"imageLayoutVersion":"1.0.0"}',
            "index.json": json.dumps({"manifests": [descriptor(manifest)]}).encode(),
        }
        for data in (config, layer, manifest):
            entries["blobs/sha256/" + push.digest(data)[7:]] = data
        if corrupt:
            entries["blobs/sha256/" + push.digest(layer)[7:]] = b"wrong"
        path = Path(folder) / "test.tar"
        with tarfile.open(path, "w") as archive:
            for name, data in entries.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            if extra:
                archive.addfile(extra)
        return path

    def test_validates_every_blob_and_platform(self):
        with tempfile.TemporaryDirectory() as folder:
            tar, *rest = push.load_archive(self.archive(folder))
            tar.close()
            for args in ({"corrupt": True}, {"architecture": "arm64"}):
                with self.assertRaises(ValueError):
                    push.load_archive(self.archive(folder, **args))

    def test_rejects_path_traversal_and_symlink(self):
        with tempfile.TemporaryDirectory() as folder:
            bad = tarfile.TarInfo("../outside")
            link = tarfile.TarInfo("blobs/sha256/" + "a" * 64)
            link.type = tarfile.SYMTYPE
            link.linkname = "/etc/passwd"
            for member in (bad, link):
                with self.assertRaises(ValueError):
                    push.load_archive(self.archive(folder, extra=member))


if __name__ == "__main__":
    unittest.main()
