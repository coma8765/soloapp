"""Exercise the real workflow shell against two synthetic immutable registries."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
STUB = r"""
import json, os, pathlib, sys
path = pathlib.Path(os.environ['REGISTRY_STATE'])
state = json.loads(path.read_text())
site = next(a.split('@')[1] for a in sys.argv if a.startswith('soloapp-cd@'))
mirror = pathlib.Path(sys.argv[0]).name == 'ssh'
with open(os.environ['CALLS'], 'a') as log:
    log.write(('mirror_' if mirror else 'upload_') + site + '\n')
expected = state.get('home' if site == 'yc' else 'yc') if mirror else 'new'
if expected is None or (site in state and state[site] != expected):
    sys.exit(1)
state[site] = expected
path.write_text(json.dumps(state))
"""


class PublicationRetryTest(unittest.TestCase):
    def run_publication(self, initial, force=False):
        workflow = yaml.safe_load((ROOT / ".github/workflows/deploy.yaml").read_text())
        script = next(
            step["run"]
            for step in workflow["jobs"]["deploy"]["steps"]
            if step.get("name") == "Publish identical runtime images to both private registries"
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / "state.json"
            state.write_text(json.dumps(initial))
            calls = root / "calls"
            for name in ("ssh", "python3"):
                stub = root / name
                stub.write_text("#!" + sys.executable + "\n" + STUB)
                stub.chmod(0o755)
            env = {
                **os.environ,
                "PATH": directory + ":/usr/bin:/bin",
                "REGISTRY_STATE": str(state),
                "CALLS": str(calls),
                "RUNNER_TEMP": directory,
                "YC_HOST": "yc",
                "HOME_HOST": "home",
                "YC_PORT": "22",
                "HOME_PORT": "8022",
                "SHA": "a" * 40,
                "IMAGES": "whoami",
                "FORCE_IMAGE_TRANSFER": str(force).lower(),
            }
            result = subprocess.run(
                [shutil.which("bash"), "-c", script], env=env, capture_output=True, text=True
            )
            return result.returncode, json.loads(state.read_text()), calls.read_text().splitlines()

    def test_reuses_either_existing_copy_without_uploading_rebuild(self):
        for initial in ({"yc": "old"}, {"home": "old"}, {"yc": "old", "home": "old"}):
            with self.subTest(initial=initial):
                code, state, calls = self.run_publication(initial)
                self.assertEqual(code, 0)
                self.assertEqual(state, {"yc": "old", "home": "old"})
                self.assertFalse(any(call.startswith("upload_") for call in calls))
                self.assertIn("mirror_yc", calls)
                self.assertIn("mirror_home", calls)

    def test_first_publication_uploads_once_then_mirrors(self):
        code, state, calls = self.run_publication({})
        self.assertEqual(code, 0)
        self.assertEqual(state, {"yc": "new", "home": "new"})
        self.assertEqual([c for c in calls if c.startswith("upload_")], ["upload_yc"])

    def test_conflicting_immutable_copies_fail_without_overwriting(self):
        initial = {"yc": "left", "home": "right"}
        code, state, _ = self.run_publication(initial)
        self.assertNotEqual(code, 0)
        self.assertEqual(state, initial)

    def test_explicit_force_transfers_both_archives_but_cannot_replace_tags(self):
        code, state, calls = self.run_publication({}, force=True)
        self.assertEqual(code, 0)
        self.assertEqual(state, {"yc": "new", "home": "new"})
        self.assertEqual(calls, ["upload_yc", "upload_home"])
        initial = {"yc": "old", "home": "old"}
        code, state, _ = self.run_publication(initial, force=True)
        self.assertNotEqual(code, 0)
        self.assertEqual(state, initial)
