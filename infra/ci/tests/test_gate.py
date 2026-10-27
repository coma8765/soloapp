import importlib.util
import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("ci_gate", ROOT / "infra/ci/gate.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class MergeGateTests(unittest.TestCase):
    def green(self):
        return {name: {"result": "success"} for name in gate.EXPECTED}

    def test_all_success(self):
        gate.check_results(self.green())

    def test_each_non_success_blocks(self):
        for name in gate.EXPECTED:
            for status in ("failure", "cancelled", "skipped", None):
                with self.subTest(job=name, status=status):
                    needs = self.green()
                    needs[name]["result"] = status
                    with self.assertRaises(ValueError):
                        gate.check_results(needs)

    def test_missing_or_unexpected_job_blocks(self):
        needs = self.green()
        needs.pop("quality")
        with self.assertRaises(ValueError):
            gate.check_results(needs)
        needs = self.green()
        needs["unregistered"] = {"result": "success"}
        with self.assertRaises(ValueError):
            gate.check_results(needs)

    def test_workflow_covers_all_jobs_and_all_pushes(self):
        workflow = yaml.load(
            (ROOT / ".github/workflows/ci.yaml").read_text(), Loader=yaml.BaseLoader
        )
        self.assertEqual(set(workflow["jobs"]) - {"required"}, gate.EXPECTED)
        self.assertEqual(set(workflow["jobs"]["required"]["needs"]), gate.EXPECTED)
        self.assertEqual(workflow["jobs"]["required"]["if"], "always()")
        self.assertEqual(workflow["on"]["push"], {"branches": ["**"]})
        self.assertIn("pull_request", workflow["on"])
        self.assertNotIn("paths", workflow["on"]["push"])
        protection = yaml.safe_load((ROOT / "infra/ci/branch-protection.yaml").read_text())
        self.assertTrue(protection["enforce_admins"])
        contexts = {item["context"] for item in protection["required_status_checks"]["checks"]}
        self.assertEqual(
            contexts,
            {"source", "quality", "services (auth)", "app-api (NestJS)", "web", "Required checks"},
        )
        self.assertIn("required_pull_request_reviews", protection)
        self.assertFalse(protection["allow_force_pushes"])
        self.assertFalse(protection["allow_deletions"])


class SiteConfigurationTests(unittest.TestCase):
    def test_all_delivery_workloads_have_independent_site_replica_settings(self):
        for site in ("yc", "home"):
            config = yaml.safe_load(
                (ROOT / "infra/ansible/host_vars" / (site + ".yaml")).read_text()
            )
            for service in ("client_gateway", "client_notify"):
                self.assertEqual(config["service_overrides"][service]["replicas"], 2)
            if site == "home":
                self.assertEqual(config["network_direct_https_mark"], "0x2024")
