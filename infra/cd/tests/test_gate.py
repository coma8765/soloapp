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

class RegistryTests(unittest.TestCase):
    def test_new_release_requires_two_matching_copies(self):
        from unittest.mock import patch, MagicMock
        ctx=MagicMock()
        def response(payload):
            value=MagicMock();value.__enter__.return_value.read.return_value=payload;return value
        with patch.object(gate.ssl,'create_default_context',return_value=ctx):
            with patch.object(gate.urllib.request,'urlopen',side_effect=[response(b'a')]*3+[OSError('offline')]):
                with self.assertRaises(RuntimeError):gate.registry_images('a'*40)
            with patch.object(gate.urllib.request,'urlopen',side_effect=[response(b'a')]*3+[response(b'b')]*3):
                with self.assertRaises(RuntimeError):gate.registry_images('a'*40)
            with patch.object(gate.urllib.request,'urlopen',side_effect=[response(b'a')]*3+[OSError('offline')]):
                self.assertEqual(len(gate.registry_images('a'*40,require_both=False)),3)
            with patch.object(gate.urllib.request,'urlopen',side_effect=OSError('offline')):
                with self.assertRaises(RuntimeError):gate.registry_images('a'*40,require_both=False)

class AppApiRegistryTests(unittest.TestCase):
    def test_app_api_digest_is_checked_on_both_sites(self):
        from unittest.mock import patch, MagicMock
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'manifest'
        services = ('auth', 'whoami', 'web', 'app-api')
        with patch.object(gate.ssl, 'create_default_context'), patch.object(
                gate.urllib.request, 'urlopen', return_value=response) as fetch:
            images = gate.registry_images('a' * 40, services=services)
        self.assertEqual(len(images), 4)
        self.assertIn('/app-api@sha256:', images[3])
        urls = [call.args[0].full_url for call in fetch.call_args_list]
        self.assertEqual(sum('/app-api/manifests/' in url for url in urls), 2)

    def test_app_api_mismatch_blocks_rollout(self):
        from unittest.mock import patch, MagicMock
        def response(payload):
            value = MagicMock()
            value.__enter__.return_value.read.return_value = payload
            return value
        with patch.object(gate.ssl, 'create_default_context'), patch.object(
                gate.urllib.request, 'urlopen',
                side_effect=[response(b'a')] * 7 + [response(b'b')]):
            with self.assertRaisesRegex(RuntimeError, 'disagree'):
                gate.registry_images('a' * 40, services=('auth', 'whoami', 'web', 'app-api'))
