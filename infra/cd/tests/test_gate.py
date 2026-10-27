import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).parents[1] / 'deploy.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

class GateTests(unittest.TestCase):
    def test_shell_input_cannot_be_a_revision(self):
        for value in ('main', '../main', 'a' * 39, 'a' * 40 + ';id', 'A' * 40, 'a' * 40 + '\n'):
            with self.assertRaises(ValueError):
                gate.validate_revision(value)
        self.assertEqual(gate.validate_revision('a' * 40), 'a' * 40)

    def test_requires_successful_push_from_this_main(self):
        good = dict(head_sha='a' * 40, head_branch='main', event='push', conclusion='success',
                    head_repository={'full_name': 'owner/repo'})
        self.assertTrue(gate.ci_passed({'workflow_runs': [good]}, 'a' * 40, 'owner/repo'))
        for change in ({'event': 'pull_request'}, {'head_branch': 'feature'}, {'conclusion': 'failure'},
                       {'head_sha': 'b' * 40}, {'head_repository': {'full_name': 'fork/repo'}}):
            self.assertFalse(gate.ci_passed({'workflow_runs': [dict(good, **change)]}, 'a' * 40, 'owner/repo'))
        self.assertFalse(gate.ci_passed({}, 'a' * 40, 'owner/repo'))
