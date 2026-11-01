import contextlib
import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import push
import upload


class LayerReuseTests(unittest.TestCase):
    def archive(self, path, omit=False):
        layer = b"large-model-layer" * 1024
        config = json.dumps(
            {
                "os": "linux",
                "architecture": "amd64",
                "config": {"Labels": {"org.opencontainers.image.revision": "a" * 40}},
            }
        ).encode()

        def desc(data):
            return {"digest": push.digest(data), "size": len(data)}

        manifest = json.dumps(
            {
                "schemaVersion": 2,
                "mediaType": "application/vnd.oci.image.manifest.v1+json",
                "config": desc(config),
                "layers": [desc(layer)],
            }
        ).encode()
        files = {
            "index.json": json.dumps({"manifests": [desc(manifest)]}).encode(),
            "oci-layout": b'{"imageLayoutVersion":"1.0.0"}',
            "blobs/sha256/" + push.digest(manifest)[7:]: manifest,
            "blobs/sha256/" + push.digest(config)[7:]: config,
        }
        if not omit:
            files["blobs/sha256/" + push.digest(layer)[7:]] = layer
        with tarfile.open(path, "w") as tar:
            for name, data in files.items():
                item = tarfile.TarInfo(name)
                item.size = len(data)
                tar.addfile(item, io.BytesIO(data))
        return desc(layer)

    def test_omitted_layer_requires_destination_confirmation(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "delta.tar"
            desc = self.archive(path, omit=True)
            for cached in (None, lambda value: False):
                with self.assertRaises(KeyError):
                    push.load_archive(path, cached=cached)
            result = push.load_archive(path, cached=lambda value: value == desc)
            result[0].close()

    def test_cached_layer_digest_and_size_must_match(self):
        desc = {"digest": "sha256:" + "a" * 64, "size": 123}
        headers = {"docker-content-digest": desc["digest"], "content-length": "123"}
        with patch.object(push, "request", return_value=(200, headers, b"")):
            self.assertTrue(push.cached_blob(None, "/v2/soloapp/whisper", desc))
        for bad in (
            {**headers, "content-length": "124"},
            {**headers, "docker-content-digest": "bad"},
        ):
            with patch.object(push, "request", return_value=(200, bad, b"")):
                with self.assertRaises(ValueError):
                    push.cached_blob(None, "/v2/soloapp/whisper", desc)
        with patch.object(push, "request", return_value=(503, {}, b"")):
            with self.assertRaises(RuntimeError):
                push.cached_blob(None, "/v2/soloapp/whisper", desc)

    def test_legacy_tar_prefix_is_preserved(self):
        source = io.BufferedReader(io.BytesIO(b"index.json" + b"\0" * 500))
        prefix = push.negotiate(source, None, "whisper")
        self.assertEqual(prefix + source.read(), b"index.json" + b"\0" * 500)

    def test_real_duplex_transfer_reuses_or_forces_layers(self):
        receiver = """import sys,json,tempfile
from pathlib import Path
sys.path.insert(0,sys.argv[1])
import push
layer=json.loads(sys.argv[2])
assert sys.stdin.buffer.readline()==push.PROTOCOL
assert json.loads(sys.stdin.buffer.readline())==[layer]
print(push.REPLY+json.dumps([layer['digest']]),flush=True)
with tempfile.TemporaryDirectory() as tmp:
 p=Path(tmp)/'received.tar';p.write_bytes(sys.stdin.buffer.read())
 result=push.load_archive(p,cached=lambda d:d==layer)
 present='blobs/sha256/'+layer['digest'][7:] in result[1]
 assert present==(sys.argv[3]=='True'),present
 result[0].close()
print('receiver verified')
"""
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "full.tar"
            desc = self.archive(path)
            for force in (False, True):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    upload.transfer(
                        path,
                        "a" * 40,
                        [sys.executable, "-c", receiver, str(ROOT), json.dumps(desc), str(force)],
                        force,
                    )
                report = json.loads(output.getvalue().splitlines()[0])
                self.assertEqual(report["reused_bytes"], 0 if force else desc["size"])
                self.assertIn("receiver verified", output.getvalue())


if __name__ == "__main__":
    unittest.main()
