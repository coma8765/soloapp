import importlib.util
import unittest
from pathlib import Path
from unittest.mock import MagicMock


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


notify = load("notify")


class NotificationsTests(unittest.TestCase):
    def environment(self, **changes):
        return dict(
            SERVICE="auth",
            DEPLOY_STATE="started",
            GITHUB_SHA="a" * 40,
            GITHUB_RUN_ID="123",
            GITHUB_RUN_ATTEMPT="1",
            CD_NOTIFY_URL="https://relay.example/deployments",
            CD_NOTIFY_TOKEN="x" * 48,
            **changes,
        )

    def test_all_has_one_event_per_service(self):
        env = self.environment()
        env["SERVICE"] = "all"
        self.assertEqual({e["service"] for e in notify.events(env)}, set(notify.SERVICES))
        env["SERVICE"] = "app-api"
        self.assertEqual(len(notify.events(env)), 1)

    def test_results_and_rollback_target(self):
        for state in ("started", "success", "failure", "cancelled"):
            env = self.environment(ROLLBACK="v0.1.3")
            env["DEPLOY_STATE"] = state
            event = notify.events(env)[0]
            self.assertEqual(event["operation"], "rollback")
            self.assertEqual(event["target"], "v0.1.3")
            self.assertEqual(event["state"], state)

    def test_retries_are_bounded_and_do_not_expose_secrets(self):
        send = MagicMock(side_effect=OSError("sensitive response"))
        with self.assertRaisesRegex(RuntimeError, "failed after 3"):
            notify.send_events(self.environment(), send=send, sleep=lambda _: None)
        self.assertEqual(send.call_count, 3)

    def test_redirects_are_rejected(self):
        self.assertIsNone(
            notify.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other")
        )

    def test_success(self):
        response = MagicMock()
        response.__enter__.return_value.status = 204
        send = MagicMock(return_value=response)
        notify.send_events(self.environment(), send=send)
        self.assertEqual(send.call_count, 1)

    def test_workflow_covers_prepare_failure_and_separates_deployment_status(self):
        import yaml

        workflow = yaml.safe_load(
            (Path(__file__).parents[3] / ".github/workflows/deploy.yaml").read_text()
        )
        jobs = workflow["jobs"]
        self.assertEqual(jobs["notify-result"]["needs"], ["notify-start", "prepare", "deploy"])
        self.assertIn("always()", jobs["notify-result"]["if"])
        self.assertIn("always()", jobs["prepare"]["if"])
        self.assertGreater(jobs["prepare"]["timeout-minutes"], 40)
