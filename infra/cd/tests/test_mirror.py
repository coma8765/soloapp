import hashlib
import importlib.util
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location(
    "mirror_gate", Path(__file__).parents[1] / "deploy.py"
)
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class Response(io.BytesIO):
    def __init__(self, body=b"", headers=None):
        super().__init__(body)
        self.headers = headers or {}


class MirrorTests(unittest.TestCase):
    def fixture(self, cached=False, corrupt=False, wrong_revision=False):
        sha = "a" * 40
        config = json.dumps(
            {
                "os": "linux",
                "architecture": "amd64",
                "config": {
                    "Labels": {
                        "org.opencontainers.image.revision": "b" * 40 if wrong_revision else sha
                    }
                },
            }
        ).encode()
        layer = b"cuda-model-content"

        def desc(data):
            return {"digest": "sha256:" + hashlib.sha256(data).hexdigest(), "size": len(data)}

        cd, ld = desc(config), desc(layer)
        manifest = json.dumps({"schemaVersion": 2, "config": cd, "layers": [ld]}).encode()
        requests = []

        def open_request(request, timeout):
            url = request if isinstance(request, str) else request.full_url
            method = "GET" if isinstance(request, str) else request.get_method()
            requests.append((url, method))
            if method == "HEAD":
                self.assertTrue(url.startswith("https://10.77.26.12:5043/v2/soloapp/whisper/"))
                if cached:
                    return Response(
                        headers={
                            "Docker-Content-Digest": ld["digest"],
                            "Content-Length": str(ld["size"]),
                        }
                    )
                raise urllib.error.HTTPError(url, 404, "missing", {}, None)
            self.assertTrue(url.startswith("https://10.77.26.11:5043/v2/soloapp/whisper/"))
            if "/manifests/" in url:
                return Response(manifest)
            if url.endswith(cd["digest"]):
                return Response(config)
            self.assertTrue(url.endswith(ld["digest"]))
            return Response(b"broken-model-bytes" if corrupt else layer)

        client = MagicMock()
        client.open.side_effect = open_request
        return sha, ld, client, requests

    def test_only_missing_layers_cross_private_link(self):
        import tarfile

        for cached in (False, True):
            sha, layer, client, requests = self.fixture(cached=cached)
            with (
                tempfile.TemporaryDirectory() as tmp,
                patch.object(gate.ssl, "create_default_context"),
                patch.object(gate.urllib.request, "build_opener", return_value=client),
            ):
                path = Path(tmp) / "image.tar"
                gate.mirror_archive(sha, "whisper", "home", path)
                with tarfile.open(path) as tar:
                    self.assertEqual(
                        "blobs/sha256/" + layer["digest"][7:] in tar.getnames(), not cached
                    )
            gets = [
                url for url, method in requests if method == "GET" and url.endswith(layer["digest"])
            ]
            self.assertEqual(len(gets), 0 if cached else 1)

    def test_corrupt_blob_and_wrong_revision_are_rejected(self):
        for kwargs in ({"corrupt": True}, {"wrong_revision": True}):
            sha, _, client, _ = self.fixture(**kwargs)
            with (
                tempfile.TemporaryDirectory() as tmp,
                patch.object(gate.ssl, "create_default_context"),
                patch.object(gate.urllib.request, "build_opener", return_value=client),
            ):
                with self.assertRaisesRegex(ValueError, "Corrupt|match approved"):
                    gate.mirror_archive(sha, "whisper", "home", Path(tmp) / "image.tar")

    def test_peer_and_command_are_fixed(self):
        for service in gate.IMAGE_SERVICES["all"]:
            self.assertEqual(
                gate.deployment_operation("mirror-" + service), ("mirror-" + service, None)
            )
        for mode in ("mirror-../../etc/passwd", "mirror-unknown", "mirror-whisper;id"):
            with self.assertRaises(ValueError):
                gate.deployment_operation(mode)
        with self.assertRaises(ValueError):
            gate.mirror_archive("a" * 40, "whisper", "https://attacker", Path("/unused"))
