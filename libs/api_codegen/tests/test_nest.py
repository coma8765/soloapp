import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import unittest

from generate_nest import render


class NestContractTests(unittest.TestCase):
    def test_generated_runtime_keeps_compatible_routes(self):
        content = render()
        self.assertIn("api/v1/whoami/v1/user-id", content)
        self.assertIn("api/v1/app-api/v1/user-id", content)
        self.assertIn("health/ready", content)
        self.assertIn("bodyLimits", content)
