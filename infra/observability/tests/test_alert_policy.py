"""Guard alert delivery semantics and complete diagnostic annotations."""

import unittest
from pathlib import Path

from libs.monitoring.alerts import load_rules

ROOT = Path(__file__).resolve().parents[3]


class AlertPolicyTests(unittest.TestCase):
    def test_every_rule_has_recovery_hold_and_actionable_runbook(self):
        runbook = (ROOT / "infra/observability/deploy/metrics/README.md").read_text()
        for group in load_rules()["groups"]:
            for rule in group["rules"]:
                if "alert" not in rule:
                    continue
                with self.subTest(alert=rule["alert"]):
                    self.assertEqual(rule["keep_firing_for"], "3m")
                    self.assertIn("## " + rule["alert"] + "\n", runbook)
                    for key in ("summary", "description", "action"):
                        self.assertTrue(rule["annotations"][key].strip())
                        self.assertNotIn("\\u", rule["annotations"][key])
                    self.assertNotIn("$value", str(rule["labels"]))

    def test_per_pod_critical_detection_keeps_one_minute_budget(self):
        rules = [r for g in load_rules()["groups"] for r in g["rules"]]
        for name in ("PodUnavailable", "PodHealthProbeFailed"):
            rule = next(r for r in rules if r.get("alert") == name)
            self.assertEqual(rule["for"], "1m")
            self.assertEqual(rule["labels"]["severity"], "critical")


if __name__ == "__main__":
    unittest.main()
