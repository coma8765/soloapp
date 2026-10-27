"""Reusable testsuite fixtures; keys are synthetic test data only."""

import json
import os
import subprocess

import pytest


@pytest.fixture(scope="session")
def hmac_file(tmp_path_factory):
    path = tmp_path_factory.mktemp("keys") / "userid-hmac"
    path.write_text("01" * 32)
    path.chmod(0o600)
    return path


@pytest.fixture
def unit_probe(hmac_file):
    def invoke(body):
        process = subprocess.run(
            [os.environ["UNIT_PROBE"]],
            input=json.dumps(body),
            text=True,
            capture_output=True,
            check=True,
            env={**os.environ, "HMAC_KEY_FILE": str(hmac_file)},
        )
        return json.loads(process.stdout)

    return invoke
