import importlib.util
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))
spec = importlib.util.spec_from_file_location(
    "wait_green", Path(__file__).parents[1] / "wait_green.py"
)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class WaitGreenTests(unittest.TestCase):
    def test_running_ci_is_waited_for(self):
        statuses = iter(["in_progress", "completed"])
        sleeps = []

        def fetch(path):
            if path.endswith("heads/main"):
                return {"object": {"sha": "a" * 40}}
            state = next(statuses)
            return {
                "workflow_runs": [
                    {
                        "head_sha": "a" * 40,
                        "head_branch": "main",
                        "event": "push",
                        "head_repository": {"full_name": "o/r"},
                        "status": state,
                        "conclusion": "success" if state == "completed" else None,
                    }
                ]
            }

        module.wait_green("o/r", "a" * 40, fetch=fetch, sleep=sleeps.append)
        self.assertEqual(sleeps, [15])

    def test_advanced_main_keeps_pinned_successful_revision(self):
        revision = "a" * 40
        head = "b" * 40

        def fetch(path):
            if path.endswith("heads/main"):
                return {"object": {"sha": head}}
            if "/compare/" in path:
                self.assertTrue(path.endswith(revision + "..." + head))
                return {"status": "ahead"}
            self.assertIn("head_sha=" + revision, path)
            return {
                "workflow_runs": [
                    {
                        "head_sha": revision,
                        "head_branch": "main",
                        "event": "push",
                        "head_repository": {"full_name": "o/r"},
                        "status": "completed",
                        "conclusion": "success",
                    }
                ]
            }

        module.wait_green("o/r", revision, fetch=fetch)

    def test_non_main_revision_is_rejected(self):
        for status in ("behind", "diverged", None):

            def fetch(path):
                if path.endswith("heads/main"):
                    return {"object": {"sha": "b" * 40}}
                return {"status": status}

            with self.assertRaisesRegex(RuntimeError, "not in main history"):
                module.wait_green("o/r", "a" * 40, fetch=fetch)

    def test_failed_ci_is_rejected_even_after_main_advances(self):
        def fetch(path):
            if path.endswith("heads/main"):
                return {"object": {"sha": "b" * 40}}
            if "/compare/" in path:
                return {"status": "ahead"}
            return {
                "workflow_runs": [
                    {"head_sha": "a" * 40, "status": "completed", "conclusion": "failure"}
                ]
            }

        with self.assertRaisesRegex(RuntimeError, "failed"):
            module.wait_green("o/r", "a" * 40, fetch=fetch)

    def test_missing_ci_waits_then_times_out(self):
        def fetch(path):
            return (
                {"object": {"sha": "a" * 40}}
                if path.endswith("heads/main")
                else {"workflow_runs": []}
            )

        clock = iter([0, 0, 30])
        sleeps = []
        with self.assertRaisesRegex(RuntimeError, "Timed out"):
            module.wait_green(
                "o/r",
                "a" * 40,
                fetch=fetch,
                clock=lambda: next(clock),
                sleep=sleeps.append,
                timeout=20,
            )
        self.assertEqual(sleeps, [15])
