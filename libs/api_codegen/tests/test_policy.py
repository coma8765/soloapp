import copy
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from generate import generate
from generate_nginx import ROOT, render
from route_policy import load


class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.specs = {}
        for name in ("auth", "whoami", "app-api"):
            self.specs[name] = load(ROOT / "services" / name)
        self.save()

    def save(self):
        for name, spec in self.specs.items():
            path = self.root / "services" / name / "docs/api.yaml"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(yaml.safe_dump(spec, sort_keys=False))

    def test_internal_routes_not_published(self):
        text = render(self.root)["routes.conf.j2"]
        self.assertNotIn("location = /api/v1/auth/v1/internal/verify", text)
        self.assertNotIn("location = /health/ready", text)
        self.assertIn("location = /_verify {\n  internal;", text)
        self.assertIn("auth_request /_verify;", text)
        self.assertNotIn("location /auth/", text)

    def test_app_api_uses_verified_identity_and_valid_ansible_variable(self):
        text = render(self.root)["routes.conf.j2"]
        route = text.split("location = /api/v1/app-api/v1/user-id {", 1)[1].split("\n}", 1)[0]
        self.assertIn("auth_request /_verify;", route)
        self.assertIn("proxy_set_header X-Verified-User-Id $verified_id;", route)
        self.assertIn("proxy_set_header X-User-Signature $user_signature;", route)
        self.assertIn("proxy_set_header X-User-Timestamp $user_timestamp;", route)
        self.assertIn('proxy_set_header Authorization "";', route)
        self.assertIn("whoami.soloapp.svc.cluster.local:{{ whoami_config.port }};", route)

    def test_websocket_upgrade_is_explicit_and_ticket_issuance_stays_protected(self):
        text = render(self.root)["routes.conf.j2"]
        websocket = text.split("location = /api/v1/app-api/v1/chat/ws {", 1)[1].split("\n}", 1)[0]
        ticket = text.split("location = /api/v1/app-api/v1/chat/socket-ticket {", 1)[1].split(
            "\n}", 1
        )[0]
        self.assertIn("proxy_set_header Upgrade $http_upgrade;", websocket)
        self.assertIn("proxy_http_version 1.1;", websocket)
        self.assertIn("proxy_buffering off;", websocket)
        self.assertIn("auth_request /_verify;", ticket)
        self.assertNotIn("proxy_set_header Upgrade", ticket)

    def test_public_to_internal_removes_route(self):
        self.specs["auth"]["paths"]["/api/v1/auth/v1/register"]["post"]["x-route"]["exposure"] = (
            "internal"
        )
        self.save()
        self.assertNotIn("location = /api/v1/auth/v1/register", render(self.root)["routes.conf.j2"])

    def test_policy_changes_drive_gateway_and_runtime(self):
        op = self.specs["whoami"]["paths"]["/api/v1/whoami/v1/user-id"]["get"]
        op["x-route"]["max_body_bytes"] = 123
        op["x-route"]["timeouts"]["read_seconds"] = 7
        op["x-route"]["rate_limit"] = {"group": "identity", "requests_per_second": 2, "burst": 0}
        self.save()
        rendered = render(self.root)
        self.assertIn("client_max_body_size 123;", rendered["routes.conf.j2"])
        self.assertIn("proxy_read_timeout 7s;", rendered["routes.conf.j2"])
        self.assertIn("limit_req zone=api_identity;", rendered["routes.conf.j2"])
        self.assertIn("zone=api_identity:10m rate=2r/s;", rendered["maps.conf.j2"])
        self.assertIn("request->body().size() > 123", generate(self.root / "services/whoami"))

    def test_security_mismatch_rejected(self):
        self.specs["whoami"]["paths"]["/api/v1/whoami/v1/user-id"]["get"]["security"] = []
        self.save()
        with self.assertRaisesRegex(ValueError, "security disagrees"):
            render(self.root)

    def test_missing_or_unknown_fields_rejected(self):
        op = self.specs["auth"]["paths"]["/api/v1/auth/v1/login"]["post"]
        for policy in ({}, {**op["x-route"], "typo": 1}):
            op["x-route"] = policy
            self.save()
            with self.assertRaises(ValueError):
                render(self.root)

    def test_invalid_numeric_settings_rejected(self):
        op = self.specs["whoami"]["paths"]["/api/v1/whoami/v1/user-id"]["get"]
        for value in (0, -1, True, "8k", 1048577):
            op["x-route"]["max_body_bytes"] = value
            self.save()
            with self.assertRaises(ValueError):
                render(self.root)

    def test_conflicting_shared_rate_rejected(self):
        self.specs["auth"]["paths"]["/api/v1/auth/v1/login"]["post"]["x-route"]["rate_limit"][
            "requests_per_second"
        ] = 6
        self.save()
        with self.assertRaisesRegex(ValueError, "Conflicting rate group"):
            render(self.root)

    def test_reserved_route_rejected(self):
        self.specs["auth"]["paths"]["/api/v1/auth/v1/internal/verify"]["get"]["x-route"][
            "exposure"
        ] = "public"
        self.save()
        with self.assertRaises(ValueError):
            render(self.root)

    def test_methods_with_different_policy_rejected(self):
        op = copy.deepcopy(self.specs["whoami"]["paths"]["/api/v1/whoami/v1/user-id"]["get"])
        op["operationId"] = "update_user_id"
        op["x-route"]["auth"] = "none"
        op["security"] = []
        self.specs["whoami"]["paths"]["/api/v1/whoami/v1/user-id"]["post"] = op
        self.save()
        with self.assertRaisesRegex(ValueError, "must share gateway policy"):
            render(self.root)

    def test_config_injection_rejected(self):
        op = self.specs["auth"]["paths"].pop("/api/v1/auth/v1/register")
        self.specs["auth"]["paths"]["/bad;return 200;"] = op
        self.save()
        with self.assertRaises(ValueError):
            render(self.root)

    def test_yaml_comments_and_block_style(self):
        path = self.root / "services/auth/docs/api.yaml"
        path.write_text("# API policy\n" + path.read_text())
        self.assertEqual(load(self.root / "services/auth"), self.specs["auth"])

    def test_duplicate_yaml_keys_rejected(self):
        path = self.root / "services/auth/docs/api.yaml"
        path.write_text(path.read_text() + "\npaths: {}\n")
        with self.assertRaisesRegex(ValueError, "Duplicate YAML key: paths"):
            load(self.root / "services/auth")

    def test_unsafe_yaml_tag_rejected(self):
        path = self.root / "services/auth/docs/api.yaml"
        path.write_text("!!python/object/apply:builtins.str [unsafe]")
        with self.assertRaises(yaml.constructor.ConstructorError):
            load(self.root / "services/auth")


if __name__ == "__main__":
    unittest.main()
