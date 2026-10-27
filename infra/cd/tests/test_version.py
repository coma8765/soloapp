import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("version", Path(__file__).parents[1] / "version.py")
version = importlib.util.module_from_spec(spec)
spec.loader.exec_module(version)


class VersionTests(unittest.TestCase):
    def test_increment_ignores_other_tags_and_reuses_same_revision(self):
        a, b = "a" * 40, "b" * 40
        self.assertEqual(version.select_version([], a), ("v0.1.0", True))
        tags = [
            {"name": "v0.1.9", "commit": {"sha": a}},
            {"name": "v0.1.10", "commit": {"sha": b}},
            {"name": "v3.0.999", "commit": {"sha": a}},
        ]
        self.assertEqual(version.select_version(tags, a), ("v0.1.9", False))
        self.assertEqual(version.select_version(tags, "c" * 40), ("v0.1.11", True))

    def test_resolves_only_existing_versions_or_full_sha(self):
        tags = [{"name": "v0.1.0", "commit": {"sha": "a" * 40}}]
        self.assertEqual(version.resolve(tags, "v0.1.0"), "a" * 40)
        self.assertEqual(version.resolve(tags, "b" * 40), "b" * 40)
        for value in ("v0.1.1", "v0.1.00", "main", "v0.1.0;id", "../main"):
            with self.assertRaises(ValueError):
                version.resolve(tags, value)
