import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("deploy", Path(__file__).parents[1] / "deploy.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class GateTests(unittest.TestCase):
    def test_shell_input_cannot_be_a_revision(self):
        for value in ("main", "../main", "a" * 39, "a" * 40 + ";id", "A" * 40, "a" * 40 + "\n"):
            with self.assertRaises(ValueError):
                gate.validate_revision(value)
        self.assertEqual(gate.validate_revision("a" * 40), "a" * 40)

    def test_requires_successful_push_from_this_main(self):
        good = dict(
            head_sha="a" * 40,
            head_branch="main",
            event="push",
            conclusion="success",
            head_repository={"full_name": "owner/repo"},
        )
        self.assertTrue(gate.ci_passed({"workflow_runs": [good]}, "a" * 40, "owner/repo"))
        for change in (
            {"event": "pull_request"},
            {"head_branch": "feature"},
            {"conclusion": "failure"},
            {"head_sha": "b" * 40},
            {"head_repository": {"full_name": "fork/repo"}},
        ):
            self.assertFalse(
                gate.ci_passed({"workflow_runs": [dict(good, **change)]}, "a" * 40, "owner/repo")
            )
        self.assertFalse(gate.ci_passed({}, "a" * 40, "owner/repo"))


class RegistryTests(unittest.TestCase):
    def test_new_release_requires_two_matching_copies(self):
        from unittest.mock import MagicMock, patch

        ctx = MagicMock()

        def response(payload):
            value = MagicMock()
            value.__enter__.return_value.read.return_value = payload
            return value

        with patch.object(gate.ssl, "create_default_context", return_value=ctx):
            with patch.object(
                gate.urllib.request,
                "urlopen",
                side_effect=[response(b"a")] * 3 + [OSError("offline")],
            ):
                with self.assertRaises(RuntimeError):
                    gate.registry_images("a" * 40)
            with patch.object(
                gate.urllib.request,
                "urlopen",
                side_effect=[response(b"a")] * 3 + [response(b"b")] * 3,
            ):
                with self.assertRaises(RuntimeError):
                    gate.registry_images("a" * 40)
            with patch.object(
                gate.urllib.request,
                "urlopen",
                side_effect=[response(b"a")] * 3 + [OSError("offline")],
            ):
                self.assertEqual(len(gate.registry_images("a" * 40, require_both=False)), 3)
            with patch.object(gate.urllib.request, "urlopen", side_effect=OSError("offline")):
                with self.assertRaises(RuntimeError):
                    gate.registry_images("a" * 40, require_both=False)


class AppApiRegistryTests(unittest.TestCase):
    def test_app_api_digest_is_checked_on_both_sites(self):
        from unittest.mock import MagicMock, patch

        response = MagicMock()
        response.__enter__.return_value.read.return_value = b"manifest"
        services = ("auth", "whoami", "web", "app-api")
        with (
            patch.object(gate.ssl, "create_default_context"),
            patch.object(gate.urllib.request, "urlopen", return_value=response) as fetch,
        ):
            images = gate.registry_images("a" * 40, services=services)
        self.assertEqual(len(images), 4)
        self.assertIn("/app-api@sha256:", images[3])
        urls = [call.args[0].full_url for call in fetch.call_args_list]
        self.assertEqual(sum("/app-api/manifests/" in url for url in urls), 2)

    def test_app_api_mismatch_blocks_rollout(self):
        from unittest.mock import MagicMock, patch

        def response(payload):
            value = MagicMock()
            value.__enter__.return_value.read.return_value = payload
            return value

        with (
            patch.object(gate.ssl, "create_default_context"),
            patch.object(
                gate.urllib.request, "urlopen", side_effect=[response(b"a")] * 7 + [response(b"b")]
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "disagree"):
                gate.registry_images("a" * 40, services=("auth", "whoami", "web", "app-api"))


class IsolatedDeploymentTests(unittest.TestCase):
    def test_only_fixed_service_scopes_are_allowed(self):
        for scope in gate.SCOPES:
            self.assertEqual(gate.deployment_operation("deploy-" + scope), ("deploy", scope))
            self.assertEqual(gate.deployment_operation("rollback-" + scope), ("rollback", scope))
        for value in [
            "deploy-../auth",
            "deploy-auth;id",
            "deploy-unknown",
            "deploy-auth,web",
            "deploy-whoami",
        ]:
            with self.assertRaises(ValueError):
                gate.deployment_operation(value)
        self.assertEqual(gate.deployment_operation("deploy"), ("deploy", "all"))

    def test_partial_release_preserves_other_service_versions(self):
        old = {"revision": "a" * 40, "images": ["auth-old", "identity-old", "web-old"]}
        new = gate.update_service_state(old, "b" * 40, "app-api", ["identity-new"])
        self.assertIsNone(new["revision"])
        self.assertEqual(
            new["services"]["app-api"], {"revision": "b" * 40, "image": "identity-new"}
        )
        self.assertEqual(new["services"]["auth"], {"revision": "a" * 40, "image": "auth-old"})
        self.assertEqual(new["services"]["web"], {"revision": "a" * 40, "image": "web-old"})
        self.assertEqual(new["services"]["nginx"], {"revision": "a" * 40})
        full = gate.update_service_state(
            new,
            "c" * 40,
            "all",
            ["auth-new", "identity-next", "web-new", "notify-new", "gateway-new", "keycloak-new"],
        )
        self.assertEqual(full["revision"], "c" * 40)

    def test_scoped_rollback_accepts_legacy_full_history_only_for_selected_image(self):
        legacy = {"images": ["auth-old", "identity-old", "web-old"]}
        self.assertEqual(gate.recorded_images(legacy, "app-api"), ["identity-old"])
        self.assertEqual(gate.recorded_images(legacy, "nginx"), [])
        scoped = {"scope": "auth", "image_map": {"auth": "auth-new"}}
        with self.assertRaises(ValueError):
            gate.recorded_images(scoped, "web")

    def test_actual_gate_passes_only_selected_ansible_tag_and_image(self):
        import json
        import tempfile
        from unittest.mock import MagicMock, patch

        for scope, workload in gate.WORKLOADS.items():
            with self.subTest(scope=scope), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp)
                state = root / "state"
                state.mkdir()
                revision = "a" * 40
                (state / "repository").mkdir()
                (state / ("release-" + revision)).mkdir()
                old = {"revision": "b" * 40, "images": ["auth-old", "identity-old", "web-old"]}
                (state / "deployed.json").write_text(json.dumps(old))
                config = root / "config.json"
                config.write_text(json.dumps({"site": "yc", "repository": "owner/repo"}))
                runtime = root / "runtime"
                runtime.mkdir()
                extras = []
                commands = []

                def execute(argv, **kwargs):
                    commands.append(argv)
                    if argv[:3] == ["git", "rev-parse", "origin/main"]:
                        return revision
                    if argv[:5] == ["k3s", "kubectl", "config", "view", "--raw"]:
                        return json.dumps({"users": [], "contexts": []})
                    if argv[:6] == ["k3s", "kubectl", "-n", "soloapp", "create", "token"]:
                        return "test-token"
                    if "infra/ansible/apps.yaml" in argv:
                        extras.append(json.loads((runtime / "extra.json").read_text()))
                    return ""

                response = MagicMock()
                response.__enter__.return_value.read.return_value = json.dumps(
                    {
                        "workflow_runs": [
                            {
                                "head_sha": revision,
                                "head_branch": "main",
                                "event": "push",
                                "conclusion": "success",
                                "head_repository": {"full_name": "owner/repo"},
                            }
                        ]
                    }
                ).encode()
                original_read = Path.read_text

                def read(path, *args, **kwargs):
                    if str(path) == "/etc/soloapp-cd/resources.json":
                        return "{}"
                    return original_read(path, *args, **kwargs)

                temp = MagicMock()
                temp.__enter__.return_value = str(runtime)
                images = [] if scope == "nginx" else ["selected-digest"]
                with (
                    patch.object(gate, "STATE", state),
                    patch.object(gate, "CONFIG", config),
                    patch.object(gate.sys, "argv", ["gate", revision, "deploy-" + scope]),
                    patch.object(gate, "run", side_effect=execute),
                    patch.object(gate, "registry_images", return_value=images) as registry,
                    patch.object(gate.urllib.request, "urlopen", return_value=response),
                    patch.object(gate.os, "chown"),
                    patch.object(gate.os, "umask"),
                    patch.object(gate.shutil, "copyfile"),
                    patch.object(gate.tempfile, "TemporaryDirectory", return_value=temp),
                    patch.object(Path, "read_text", read),
                ):
                    gate.main()
                rolls = [cmd for cmd in commands if "infra/ansible/apps.yaml" in cmd]
                self.assertEqual(len(rolls), 2)
                for cmd in rolls:
                    self.assertEqual(cmd[cmd.index("--tags") + 1], workload)
                for extra in extras:
                    self.assertEqual(
                        {k for k in extra if k.endswith("_image")},
                        set() if scope == "nginx" else {workload.replace("-", "_") + "_image"},
                    )
                    self.assertEqual("web_release" in extra, scope == "web")
                storage = [cmd for cmd in commands if "/src/infra/object-storage/publish.py" in cmd]
                self.assertEqual(len(storage), int(scope == "web"))
                if scope == "nginx":
                    registry.assert_not_called()
                else:
                    registry.assert_called_once_with(
                        revision, require_both=True, services=(workload,)
                    )
                current = json.loads((state / "deployed.json").read_text())
                for other in gate.WORKLOADS:
                    if (
                        other in ("client-notify", "client-gateway", "keycloak", "whisper")
                        and other != scope
                    ):
                        self.assertNotIn(other, current["services"])
                        continue
                    self.assertEqual(
                        current["services"][other]["revision"],
                        revision if other == scope else "b" * 40,
                    )
