import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


migration = load("migrate_storage")
config = load("filesystem_config")


class FilesystemMigrationTest(unittest.TestCase):
    def test_rejects_unsafe_keys(self):
        for key in [
            "/docker/registry/v2/test",
            "docker/registry/v2/../../secret",
            "docker/registry/v2//test",
            "other/data",
            "docker/registry/v2/a\\b",
        ]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                migration.relative_key(key)
        self.assertEqual(
            str(migration.relative_key("docker/registry/v2/repositories/app/tag/link")),
            "docker/registry/v2/repositories/app/tag/link",
        )

    def test_rejects_corrupt_content_addressed_blob(self):
        key = "docker/registry/v2/blobs/sha256/aa/" + "a" * 64 + "/data"
        migration.check_blob(key, "a" * 64)
        with self.assertRaises(ValueError):
            migration.check_blob(key, "b" * 64)

    def test_storage_change_preserves_auth_and_readonly(self):
        before = {
            "http": {"tls": {"clientcas": ["/tls/pull-ca.crt"]}, "secret": "fixture"},
            "storage": {
                "s3": {"secretkey": "fixture"},
                "delete": {"enabled": False},
                "maintenance": {"readonly": {"enabled": True}},
            },
        }
        after = config.filesystem_config(before)
        self.assertIn("s3", before["storage"])
        self.assertNotIn("s3", after["storage"])
        self.assertEqual(after["http"], before["http"])
        self.assertEqual(after["storage"]["maintenance"], before["storage"]["maintenance"])
        self.assertFalse(after["storage"]["delete"]["enabled"])
        self.assertEqual(after["storage"]["filesystem"]["rootdirectory"], "/var/lib/registry")
        self.assertEqual(config.filesystem_config(after), after)
